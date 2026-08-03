import express from "express";
import { db, logAudit, nextStockNumber } from "../db.js";
import { requireAuth, requirePermission } from "../middleware/auth.js";

const router = express.Router();
router.use(requireAuth);
router.use(requirePermission("production"));

function uid(prefix) { return prefix + "_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }
function num(v) { const n = Number(v); return Number.isFinite(n) ? n : 0; }
function money(v) { return Math.round(num(v) * 100) / 100; }
function str(v, max = 300) { return String(v == null ? "" : v).replace(/[\r\n\t]+/g, " ").trim().slice(0, max); }

const SOURCE_LABEL = {
  overproduced: "сшито на запас",
  returned: "вернулось с возврата",
  cancelled: "с отменённого заказа"
};
// За вещь с возврата или отмены платить не нужно: её уже кто-то сделал и
// получил деньги раньше. Оплачивается только то, что сшили специально на запас.
const PAID_SOURCES = new Set(["overproduced"]);

// Изделие проходит две работы, и делают их разные люди.
const STAGE = {
  sewn:   { label: "сшито, не забито", next: "ready" },
  ready:  { label: "готово",           next: null },
  defect: { label: "брак",             next: null }
};

// Расценка из Справочника делится на две части. Если доля швеи не заполнена,
// вся сумма считается забивкой — так работало раньше, и цифры не поедут.
function ratesFor(article) {
  const item = article ? db.prepare("SELECT labor_rate, sew_rate FROM price_items WHERE article = ?").get(article) : null;
  const total = num(item?.labor_rate);
  const sew = Math.min(num(item?.sew_rate), total);
  return { total, sew, fill: money(total - sew) };
}

function logMove(row, user, action, extra = {}) {
  db.prepare(`INSERT INTO warehouse_moves (id, stock_id, stock_number, at, user, action, order_id, order_number, employee_id, amount, comment)
              VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
    .run(uid("wm"), row.id, row.stock_number || null, new Date().toISOString(), user || "", action,
         extra.orderId || null, extra.orderNumber || null, extra.employeeId || null,
         extra.amount == null ? null : money(extra.amount), extra.comment ? str(extra.comment) : null);
}

// Начисление, привязанное к складской позиции. Ищем и по прямой ссылке, и по
// старому полю warehouse_stock_id — записи, созданные до этой доработки,
// связаны только через него.
function entryOf(row) {
  if (row.payroll_entry_id) {
    const e = db.prepare("SELECT * FROM payroll_entries WHERE id = ? AND status != 'cancelled'").get(row.payroll_entry_id);
    if (e) return e;
  }
  return db.prepare("SELECT * FROM payroll_entries WHERE warehouse_stock_id = ? AND status != 'cancelled'").get(row.id) || null;
}

function empName(id) {
  if (!id) return "";
  const e = db.prepare("SELECT name FROM employees WHERE id = ?").get(id);
  return e ? e.name : "";
}

// Начисление по конкретной работе (пошив или забивка)
function entryById(id) {
  return id ? db.prepare("SELECT * FROM payroll_entries WHERE id = ? AND status != 'cancelled'").get(id) : null;
}

function itemJson(r) {
  const entry = entryOf(r);
  const empId = r.employee_id || entry?.employee_id || null;
  const emp = empId ? db.prepare("SELECT name FROM employees WHERE id = ?").get(empId) : null;
  const rates = ratesFor(r.article);
  const sewEntry = entryById(r.sew_entry_id);
  const fillEntry = entryById(r.fill_entry_id);
  const stage = r.stage || "ready";
  const order = r.consumed_by_order_id
    ? db.prepare("SELECT display_number, kaspi_code, shop FROM orders WHERE id = ?").get(r.consumed_by_order_id) : null;
  return {
    id: r.id,
    number: r.stock_number || null,
    qty: num(r.qty) || 1,
    source: r.source || "overproduced",
    sourceLabel: SOURCE_LABEL[r.source] || r.source || "—",
    // Платить или нет решает происхождение вещи, а не то, кто её выдал
    payable: PAID_SOURCES.has(r.source || "overproduced"),
    employeeId: empId,
    employeeName: emp ? emp.name : "",
    entryId: entry ? entry.id : null,
    entryStatus: entry ? entry.status : null,
    amount: entry ? money(entry.amount) : 0,
    // Стадия: сшито (чехол готов) → готово (забито). Разные работы, разные люди.
    stage,
    stageLabel: (STAGE[stage] || {}).label || stage,
    sewnBy: r.sewn_by || null,
    sewnByName: empName(r.sewn_by),
    sewnAt: r.sewn_at || null,
    filledBy: r.filled_by || null,
    filledByName: empName(r.filled_by),
    filledAt: r.filled_at || null,
    sewRate: rates.sew,
    fillRate: rates.fill,
    totalRate: rates.total,
    sewAmount: sewEntry ? money(sewEntry.amount) : 0,
    fillAmount: fillEntry ? money(fillEntry.amount) : 0,
    sewPaid: sewEntry ? sewEntry.status : null,
    fillPaid: fillEntry ? fillEntry.status : null,
    // Что делать дальше: пока не забито — забить, потом выдавать в заказ
    nextAction: stage === "sewn" ? "fill" : (stage === "defect" ? null : "issue"),
    defectReason: r.defect_reason || null,
    status: r.status || "available",
    location: r.location || "",
    comment: r.comment || "",
    createdAt: r.created_at,
    createdBy: r.created_by || "",
    consumed: !!r.consumed,
    consumedAt: r.consumed_at || null,
    consumedBy: r.consumed_by || "",
    orderId: r.consumed_by_order_id || null,
    orderNumber: order ? order.display_number : null,
    kaspiCode: order ? order.kaspi_code : null
  };
}

// Остатки: одна строка на артикул, чтобы менеджер видел «чего и сколько есть»,
// а не список отдельных поступлений
router.get("/", (req, res) => {
  const withConsumed = req.query.consumed === "1";
  const where = [];
  if (!withConsumed) where.push("consumed = 0");
  if (req.query.source) where.push(`source = '${String(req.query.source).replace(/[^a-z]/g, "")}'`);
  const rows = db.prepare(`SELECT * FROM warehouse_stock ${where.length ? "WHERE " + where.join(" AND ") : ""}
                           ORDER BY created_at DESC`).all();

  const q = String(req.query.q || "").trim().toLowerCase();
  const byArticle = new Map();
  for (const r of rows) {
    const item = r.article ? db.prepare("SELECT name, photo, retail, labor_rate, type FROM price_items WHERE article = ?").get(r.article) : null;
    const displayName = item?.name || r.product_name || "";
    // Поиск по названию, артикулу и НОМЕРУ позиции. Фильтруем здесь, а не в SQL:
    // встроенный lower() в SQLite не умеет кириллицу и русские названия не искал
    if (q && !(
      String(r.article || "").toLowerCase().includes(q) ||
      displayName.toLowerCase().includes(q) ||
      String(r.stock_number || "").includes(q)
    )) continue;

    const key = String(r.article || "").trim() || displayName || ("__" + r.id);
    if (!byArticle.has(key)) {
      byArticle.set(key, {
        article: r.article || "",
        // Безымянных куч быть не должно: если ни артикула, ни названия нет,
        // подписываем номером позиции, чтобы вещь можно было опознать
        name: displayName || `Без названия № ${r.stock_number || "—"}`,
        unnamed: !displayName,
        photo: item?.photo || null, category: item?.type || "", retail: num(item?.retail),
        laborRate: num(item?.labor_rate), qty: 0, bySource: {}, pendingAmount: 0, items: []
      });
    }
    const g = byArticle.get(key);
    const one = itemJson(r);
    g.qty += one.qty;
    g.bySource[one.source] = (g.bySource[one.source] || 0) + one.qty;
    if (one.payable && one.entryStatus === "pending") g.pendingAmount += one.amount;
    g.items.push(one);
  }

  const groups = Array.from(byArticle.values())
    .map(g => ({ ...g, pendingAmount: money(g.pendingAmount) }))
    .sort((a, b) => (a.category || "").localeCompare(b.category || "", "ru") || a.name.localeCompare(b.name, "ru"));
  res.json({
    groups,
    totals: {
      positions: groups.length,
      units: groups.reduce((s, g) => s + g.qty, 0),
      retailValue: Math.round(groups.reduce((s, g) => s + g.qty * g.retail, 0)),
      // Сколько денег «спит» на складе: работа сделана, но платим только
      // после того, как вещь уйдёт в заказ
      pendingPayroll: money(groups.reduce((s, g) => s + g.pendingAmount, 0)),
      unnamed: groups.filter(g => g.unnamed).reduce((s, g) => s + g.qty, 0),
      bySource: groups.reduce((acc, g) => {
        for (const [k, v] of Object.entries(g.bySource)) acc[k] = (acc[k] || 0) + v;
        return acc;
      }, {})
    }
  });
});

// Одна позиция целиком, вместе с историей движения
router.get("/item/:id", (req, res) => {
  const row = db.prepare("SELECT * FROM warehouse_stock WHERE id = ?").get(req.params.id);
  if (!row) return res.status(404).json({ error: "not_found" });
  const moves = db.prepare("SELECT * FROM warehouse_moves WHERE stock_id = ? ORDER BY at DESC").all(row.id);
  res.json(Object.assign(itemJson(row), {
    moves: moves.map(m => ({
      at: m.at, user: m.user, action: m.action, orderNumber: m.order_number,
      amount: m.amount, comment: m.comment
    }))
  }));
});

// Ручное добавление на склад: например, нашли изделие, которого не было в учёте
router.post("/", (req, res) => {
  const b = req.body || {};
  const article = str(b.article, 60);
  if (!article) return res.status(400).json({ error: "article_required", message: "Выберите товар" });
  const item = db.prepare("SELECT * FROM price_items WHERE article = ?").get(article);
  const qty = Math.max(1, num(b.qty) || 1);
  const source = ["overproduced", "returned", "cancelled"].includes(b.source) ? b.source : "overproduced";
  const employeeId = b.employeeId && db.prepare("SELECT id FROM employees WHERE id = ?").get(b.employeeId) ? b.employeeId : null;
  const now = new Date().toISOString();
  const id = uid("ws");
  const number = nextStockNumber();

  db.prepare(`INSERT INTO warehouse_stock (id, stock_number, article, product_name, source, qty, consumed,
              employee_id, comment, created_by, created_at)
              VALUES (?,?,?,?,?,?,0,?,?,?,?)`)
    .run(id, number, article, item ? (item.name || item.kaspi_name) : str(b.name, 200),
         source, qty, employeeId, str(b.comment, 500) || null, req.session.username, now);

  const row = db.prepare("SELECT * FROM warehouse_stock WHERE id = ?").get(id);
  logMove(row, req.session.username, "in", { employeeId, comment: SOURCE_LABEL[source] });
  logAudit({ user: req.session.username, action: "warehouse_add", comment: `№${number} ${article} ×${qty}` });
  res.json({ ok: true, id, number });
});

// Правка позиции: место, состояние, комментарий, кто сшил
router.put("/item/:id", (req, res) => {
  const row = db.prepare("SELECT * FROM warehouse_stock WHERE id = ?").get(req.params.id);
  if (!row) return res.status(404).json({ error: "not_found" });
  if (row.consumed) return res.status(400).json({ error: "consumed", message: "Позиция уже выдана — её нельзя менять" });
  const b = req.body || {};
  const sets = [], params = [], changed = [];

  if (b.employeeId !== undefined) {
    const empId = b.employeeId || null;
    if (empId && !db.prepare("SELECT id FROM employees WHERE id = ?").get(empId)) {
      return res.status(400).json({ error: "no_employee", message: "Сотрудник не найден" });
    }
    sets.push("employee_id = ?"); params.push(empId); changed.push("кто сшил");
    // Тот же человек должен стоять и в начислении, иначе деньги уйдут не тому
    const entry = entryOf(row);
    if (entry && entry.status === "pending") {
      db.prepare("UPDATE payroll_entries SET employee_id = ?, assigned_by = ?, assigned_at = ? WHERE id = ?")
        .run(empId, req.session.username, new Date().toISOString(), entry.id);
    }
  }
  if (b.location !== undefined) { sets.push("location = ?"); params.push(str(b.location, 100)); changed.push("место"); }
  if (b.comment !== undefined) { sets.push("comment = ?"); params.push(str(b.comment, 500)); changed.push("комментарий"); }
  if (b.status !== undefined && ["available", "reserved", "damaged"].includes(b.status)) {
    sets.push("status = ?"); params.push(b.status); changed.push("состояние");
  }
  if (b.name !== undefined && !row.article) {
    // Безымянную позицию можно подписать руками — иначе она останется «—» навсегда
    sets.push("product_name = ?"); params.push(str(b.name, 200)); changed.push("название");
  }
  if (!sets.length) return res.json({ ok: true });
  params.push(row.id);
  db.prepare(`UPDATE warehouse_stock SET ${sets.join(", ")} WHERE id = ?`).run(...params);
  logMove(row, req.session.username, "edit", { comment: "Изменено: " + changed.join(", ") });
  res.json({ ok: true });
});

// Общая заготовка начисления за одну работу. Деньги ждут: пока вещь лежит
// на складе, начисление в состоянии «отложено», к выплате оно пойдёт, только
// когда изделие уйдёт в заказ.
function makeEntry({ employeeId, row, kindLabel, amount, user }) {
  const id = uid("pay");
  const now = new Date().toISOString();
  db.prepare(`INSERT INTO payroll_entries
    (id, employee_id, warehouse_stock_id, shop, article, product_name, qty, rate, amount,
     kind, status, comment, created_by, created_at, reported_done, assigned_by, assigned_at)
    VALUES (?,?,?,?,?,?,1,?,?,'stock','pending',?,?,?,0,?,?)`)
    .run(id, employeeId, row.id, row.shop || null, row.article, row.product_name,
         amount, amount, `${kindLabel}, склад №${row.stock_number || "—"}`, user, now, user, now);
  db.prepare(`INSERT INTO payroll_entry_log (id, entry_id, at, user, action, field, old_value, new_value, comment)
              VALUES (?,?,?,?,'assign','employee','не разнесено',?,?)`)
    .run(uid("plog"), id, now, user, empName(employeeId), kindLabel);
  return id;
}

// Перевод на следующую стадию: сшито → забито. Здесь же фиксируем, кто это
// сделал, и заводим ему начисление по его доле расценки.
router.post("/:id/stage", (req, res) => {
  const row = db.prepare("SELECT * FROM warehouse_stock WHERE id = ?").get(req.params.id);
  if (!row) return res.status(404).json({ error: "not_found" });
  if (row.consumed) return res.status(400).json({ error: "consumed", message: "Изделие уже выдано в заказ" });
  if ((row.stage || "ready") !== "sewn") {
    return res.status(400).json({ error: "bad_stage", message: "Забивать можно только то, что сшито и ещё не забито" });
  }
  const employeeId = req.body?.employeeId || null;
  if (!employeeId || !db.prepare("SELECT id FROM employees WHERE id = ?").get(employeeId)) {
    return res.status(400).json({ error: "no_employee", message: "Укажите, кто забил" });
  }
  const rates = ratesFor(row.article);
  const now = new Date().toISOString();
  const amount = money(rates.fill * (num(row.qty) || 1));

  const entryId = makeEntry({ employeeId, row, kindLabel: "Забивка", amount, user: req.session.username });
  db.prepare("UPDATE warehouse_stock SET stage = 'ready', filled_by = ?, filled_at = ?, fill_entry_id = ? WHERE id = ?")
    .run(employeeId, now, entryId, row.id);
  logMove(row, req.session.username, "edit", { employeeId, amount, comment: `Забито — ${empName(employeeId)}` });
  logAudit({ user: req.session.username, action: "warehouse_filled",
             comment: `№${row.stock_number}: забил ${empName(employeeId)}, ${amount} ₸` });
  res.json({ ok: true, amount, employeeName: empName(employeeId),
             message: `Готово. ${empName(employeeId)} получит ${amount} ₸ за забивку — после выдачи в заказ.` });
});

// Брак: изделие испортили. Со склада уходит, начисления отменяются —
// платить за испорченное не за что.
router.post("/:id/defect", (req, res) => {
  const row = db.prepare("SELECT * FROM warehouse_stock WHERE id = ?").get(req.params.id);
  if (!row) return res.status(404).json({ error: "not_found" });
  if (row.consumed) return res.status(400).json({ error: "consumed", message: "Изделие уже выдано в заказ" });
  const reason = str(req.body?.reason, 300);
  if (!reason) return res.status(400).json({ error: "no_reason", message: "Напишите, что случилось" });

  let cancelled = 0;
  for (const id of [row.sew_entry_id, row.fill_entry_id, entryOf(row)?.id]) {
    const e = entryById(id);
    if (!e || e.status === "paid") continue;
    db.prepare("UPDATE payroll_entries SET status = 'cancelled', comment = ? WHERE id = ?")
      .run(`Брак: ${reason}`, e.id);
    cancelled++;
  }
  db.prepare("UPDATE warehouse_stock SET stage = 'defect', defect_reason = ? WHERE id = ?").run(reason, row.id);
  logMove(row, req.session.username, "damaged", { comment: reason });
  logAudit({ user: req.session.username, action: "warehouse_defect", comment: `№${row.stock_number}: ${reason}` });
  res.json({ ok: true, cancelled,
             message: cancelled ? `Помечено браком. Отменено начислений: ${cancelled}.` : "Помечено браком." });
});

// Удаление позиции. Нужно, чтобы убирать мусор — например, безымянные строки,
// приехавшие с возвратов. Уже выданное и уже оплаченное не трогаем.
router.delete("/:id", (req, res) => {
  const row = db.prepare("SELECT * FROM warehouse_stock WHERE id = ?").get(req.params.id);
  if (!row) return res.status(404).json({ error: "not_found" });
  if (row.consumed) return res.status(400).json({ error: "consumed",
    message: "Изделие уже выдано в заказ — удалять нельзя, иначе потеряется история" });

  const paid = [row.sew_entry_id, row.fill_entry_id, entryOf(row)?.id]
    .map(entryById).filter(e => e && e.status === "paid");
  if (paid.length) return res.status(400).json({ error: "already_paid",
    message: "За это изделие уже выплачены деньги — удалить нельзя" });

  let cancelled = 0;
  for (const id of [row.sew_entry_id, row.fill_entry_id, entryOf(row)?.id]) {
    const e = entryById(id);
    if (!e) continue;
    db.prepare("UPDATE payroll_entries SET status = 'cancelled', comment = ? WHERE id = ?")
      .run("Позиция склада удалена", e.id);
    cancelled++;
  }
  db.prepare("DELETE FROM warehouse_moves WHERE stock_id = ?").run(row.id);
  db.prepare("DELETE FROM warehouse_stock WHERE id = ?").run(row.id);
  logAudit({ user: req.session.username, action: "warehouse_delete",
             comment: `№${row.stock_number || "—"} ${row.article || row.product_name || ""}` });
  res.json({ ok: true, cancelled,
             message: cancelled ? `Удалено. Отменено начислений: ${cancelled}.` : "Удалено." });
});

// Списание со склада в заказ. Здесь же решается вопрос денег: как только вещь
// ушла в заказ, работа за неё становится к выплате и вешается на того, кто шил.
// До этого начисление лежит «отложено»: изделие ещё не продано.
router.post("/:id/consume", (req, res) => {
  const row = db.prepare("SELECT * FROM warehouse_stock WHERE id = ?").get(req.params.id);
  if (!row) return res.status(404).json({ error: "not_found" });
  if (row.consumed) return res.status(400).json({ error: "already", message: "Эта позиция уже списана" });

  const orderId = str(req.body?.orderId, 60) || null;
  const order = orderId ? db.prepare("SELECT * FROM orders WHERE id = ?").get(orderId) : null;
  if (orderId && !order) return res.status(400).json({ error: "no_order", message: "Заказ не найден" });
  const now = new Date().toISOString();

  db.prepare("UPDATE warehouse_stock SET consumed = 1, consumed_by_order_id = ?, consumed_at = ?, consumed_by = ? WHERE id = ?")
    .run(orderId, now, req.session.username, row.id);

  // Изделие делают двое, и деньги идут обоим сразу: и швее за пошив, и
  // забивщику за забивку. Раньше начисление было одно — второй человек
  // оставался без оплаты.
  let accrued = 0;
  const paidTo = [];
  if (PAID_SOURCES.has(row.source || "overproduced")) {
    const ids = [row.sew_entry_id, row.fill_entry_id];
    const legacy = entryOf(row);
    if (legacy && !ids.includes(legacy.id)) ids.push(legacy.id);
    for (const id of ids) {
      const e = entryById(id);
      if (!e || e.status !== "pending" || !e.employee_id) continue;
      db.prepare("UPDATE payroll_entries SET status = 'payable', accepted_at = ?, accepted_by = ?, order_id = COALESCE(order_id, ?) WHERE id = ?")
        .run(now, req.session.username, orderId, e.id);
      db.prepare(`INSERT INTO payroll_entry_log (id, entry_id, at, user, action, field, old_value, new_value, comment)
                  VALUES (?,?,?,?,'accept','status','отложено','к выплате',?)`)
        .run(uid("plog"), e.id, now, req.session.username,
             `Выдано со склада №${row.stock_number || "—"}${order ? ` в заказ №${order.display_number}` : ""}`);
      accrued += money(e.amount);
      paidTo.push(`${empName(e.employee_id)} ${money(e.amount)} ₸`);
    }
  }
  accrued = money(accrued);
  const employeeName = paidTo.join(", ");

  // Если списываем под заказ — закрываем и запись в производстве, чтобы она
  // не висела «ждёт решения»
  if (orderId) {
    const prod = db.prepare("SELECT * FROM production WHERE order_id = ? AND decision IS NULL").get(orderId);
    if (prod) db.prepare("UPDATE production SET decision = 'stock', resolved_at = ? WHERE id = ?").run(now, prod.id);
  }

  logMove(row, req.session.username, "out", {
    orderId, orderNumber: order ? order.display_number : null,
    employeeId: row.filled_by || row.sewn_by || row.employee_id, amount: accrued,
    comment: accrued ? `К выплате ${accrued} ₸ — ${employeeName}` : "Оплата не начисляется"
  });
  logAudit({ user: req.session.username, action: "warehouse_consume",
             comment: `№${row.stock_number || "—"} ${row.article || row.product_name}${order ? ` → заказ №${order.display_number}` : ""}${accrued ? `, к выплате ${accrued} ₸` : ""}` });
  res.json({ ok: true, accrued, employeeName,
             message: accrued
               ? `Выдано. К выплате ${accrued} ₸: ${employeeName}.`
               : "Выдано. Оплата не начисляется: вещь пришла с возврата или отмены." });
});

// Вернуть выданное обратно на склад — если ошиблись заказом
router.post("/:id/restore", (req, res) => {
  const row = db.prepare("SELECT * FROM warehouse_stock WHERE id = ?").get(req.params.id);
  if (!row) return res.status(404).json({ error: "not_found" });
  if (!row.consumed) return res.status(400).json({ error: "not_consumed", message: "Позиция и так на складе" });

  const ids = [row.sew_entry_id, row.fill_entry_id];
  const legacy = entryOf(row);
  if (legacy && !ids.includes(legacy.id)) ids.push(legacy.id);
  // Уже выплаченное не откатываем: деньги на руках, откатывать нечего
  if (ids.map(entryById).some(e => e && e.status === "paid")) {
    return res.status(400).json({ error: "already_paid",
      message: "За эту вещь уже выплачены деньги — вернуть на склад нельзя" });
  }
  db.prepare("UPDATE warehouse_stock SET consumed = 0, consumed_by_order_id = NULL, consumed_at = NULL, consumed_by = NULL WHERE id = ?").run(row.id);
  for (const id of ids) {
    const e = entryById(id);
    if (!e || e.status !== "payable") continue;
    db.prepare("UPDATE payroll_entries SET status = 'pending', accepted_at = NULL, accepted_by = NULL WHERE id = ?").run(e.id);
    db.prepare(`INSERT INTO payroll_entry_log (id, entry_id, at, user, action, field, old_value, new_value, comment)
                VALUES (?,?,?,?,'edit','status','к выплате','отложено','Вещь вернули на склад')`)
      .run(uid("plog"), e.id, new Date().toISOString(), req.session.username);
  }
  logMove(row, req.session.username, "restored", { comment: str(req.body?.reason) || "Возврат на склад" });
  logAudit({ user: req.session.username, action: "warehouse_restore", comment: `№${row.stock_number || "—"}` });
  res.json({ ok: true });
});

// История движения всего склада — для выгрузки и разбора «куда делось»
router.get("/moves", (req, res) => {
  const rows = db.prepare("SELECT * FROM warehouse_moves ORDER BY at DESC LIMIT 2000").all();
  const ACTION = { in: "поступило", out: "выдано", edit: "правка", restored: "возвращено на склад", damaged: "брак" };
  res.json(rows.map(m => {
    const st = db.prepare("SELECT article, product_name FROM warehouse_stock WHERE id = ?").get(m.stock_id);
    const emp = m.employee_id ? db.prepare("SELECT name FROM employees WHERE id = ?").get(m.employee_id) : null;
    return {
      at: m.at, user: m.user, action: m.action, actionLabel: ACTION[m.action] || m.action,
      number: m.stock_number, article: st?.article || "", name: st?.product_name || "",
      orderNumber: m.order_number, employeeName: emp?.name || "", amount: m.amount, comment: m.comment
    };
  }));
});

// Заказы, ждущие решения — чтобы списать со склада прямо в нужный заказ
router.get("/pending-orders", (req, res) => {
  const rows = db.prepare(`SELECT p.id AS production_id, p.article, p.product_name, p.quantity,
                                  o.id AS order_id, o.display_number, o.shop, o.kaspi_code
                           FROM production p LEFT JOIN orders o ON o.id = p.order_id
                           WHERE p.decision IS NULL ORDER BY o.display_number`).all();
  res.json(rows.map(r => ({
    productionId: r.production_id, orderId: r.order_id, number: r.display_number,
    shop: r.shop, kaspiCode: r.kaspi_code, article: r.article,
    name: r.product_name, qty: num(r.quantity) || 1
  })));
});

export default router;

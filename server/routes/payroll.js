import express from "express";
import { db, logAudit } from "../db.js";
import { requireAuth } from "../middleware/auth.js";

const router = express.Router();
router.use(requireAuth);

function uid(prefix) { return prefix + "_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }
function num(v, def = 0) { const n = Number(v); return Number.isFinite(n) ? n : def; }
function str(v, max = 500) { return String(v == null ? "" : v).replace(/[\r\n\t]+/g, " ").trim().slice(0, max); }
function money(v) { return Math.round(num(v) * 100) / 100; }

// Расценка берётся ТОЛЬКО из Справочника (price_items.labor_rate) — так решили
// сознательно, чтобы сумма не зависела от того, кто что вписал руками.
// Найденное значение копируется в строку начисления и дальше не меняется:
// правка расценки в Справочнике не переписывает уже принятые работы.
function findRate(itemId, article) {
  let row = null;
  if (itemId) row = db.prepare("SELECT * FROM price_items WHERE id = ?").get(itemId);
  if (!row && article) row = db.prepare("SELECT * FROM price_items WHERE article = ?").get(article);
  if (!row) return { rate: 0, found: false, item: null };
  return { rate: num(row.labor_rate), found: true, item: row };
}

// Запись в журнал правок строки. Пишем даже мелочи — потом именно по этим
// строчкам разбираются, откуда у человека взялась сумма.
function logChange(entryId, user, action, field, oldValue, newValue, comment) {
  db.prepare(`INSERT INTO payroll_entry_log (id, entry_id, at, user, action, field, old_value, new_value, comment)
              VALUES (?,?,?,?,?,?,?,?,?)`)
    .run(uid("plog"), entryId, new Date().toISOString(), user || "", action, field || null,
         oldValue == null ? null : String(oldValue), newValue == null ? null : String(newValue),
         comment ? str(comment) : null);
}

// Номер заказа и код Kaspi — то, по чему заказ ищут глазами. Держим отдельной
// функцией: строка начисления хранит только order_id, а показывать надо номер.
function orderInfo(orderId) {
  if (!orderId) return null;
  return db.prepare("SELECT display_number, kaspi_code, shop, kaspi_creation_date, created_at, total_price, product_name FROM orders WHERE id = ?")
    .get(orderId) || null;
}

function entryToJson(e, joined) {
  const emp = e.employee_id ? db.prepare("SELECT name FROM employees WHERE id = ?").get(e.employee_id) : null;
  // joined — строка уже с полями заказа из общего запроса (чтобы не долбить
  // базу по разу на каждую работу в списке из тысячи строк)
  const o = joined !== undefined ? joined : orderInfo(e.order_id);
  return {
    id: e.id,
    employeeId: e.employee_id,
    employeeName: emp ? emp.name : "",
    orderNumber: o ? o.display_number : null,
    kaspiCode: o ? o.kaspi_code : null,
    orderDate: o ? (o.kaspi_creation_date || o.created_at || null) : null,
    orderTotal: o ? num(o.total_price) : 0,
    assignedBy: e.assigned_by || null,
    assignedAt: e.assigned_at || null,
    archivedAt: e.archived_at || null,
    archivedBy: e.archived_by || null,
    productionId: e.production_id,
    orderId: e.order_id,
    shop: e.shop,
    warehouseStockId: e.warehouse_stock_id,
    article: e.article,
    productName: e.product_name,
    qty: num(e.qty),
    rate: num(e.rate),
    amount: num(e.amount),
    kind: e.kind,
    status: e.status,
    comment: e.comment,
    reportedDone: !!e.reported_done,
    reportedWeight: e.reported_weight,
    reportedAt: e.reported_at,
    reportedBy: e.reported_by,
    acceptedAt: e.accepted_at,
    acceptedBy: e.accepted_by,
    paidAt: e.paid_at,
    payoutId: e.payout_id,
    createdAt: e.created_at,
    needsRate: num(e.rate) === 0
  };
}

function insertEntry(data) {
  const id = uid("pay");
  const amount = money(num(data.rate) * num(data.qty, 1));
  db.prepare(`INSERT INTO payroll_entries
    (id, employee_id, production_id, order_id, warehouse_stock_id, shop, article, product_name,
     qty, rate, amount, kind, status, comment, created_by, created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,'pending',?,?,?)`)
    .run(id, data.employeeId, data.productionId || null, data.orderId || null, data.warehouseStockId || null,
         data.shop || null, data.article || "", data.productName || "", num(data.qty, 1), num(data.rate), amount,
         data.kind || "order", str(data.comment), data.user, new Date().toISOString());
  return db.prepare("SELECT * FROM payroll_entries WHERE id = ?").get(id);
}

// Основной исполнитель: у вас швей двое-трое, но одна основная — храним её
// на сервере, а не в браузере, потому что за программой сидят разные люди
router.get("/settings", (req, res) => {
  const row = db.prepare("SELECT value FROM meta WHERE key = 'payroll_default_employee'").get();
  const id = row ? row.value : null;
  const emp = id ? db.prepare("SELECT * FROM employees WHERE id = ?").get(id) : null;
  res.json({ defaultEmployeeId: emp ? emp.id : null, defaultEmployeeName: emp ? emp.name : "" });
});

router.put("/settings", (req, res) => {
  const id = req.body?.defaultEmployeeId || "";
  if (id && !db.prepare("SELECT id FROM employees WHERE id = ?").get(id)) {
    return res.status(400).json({ error: "no_employee", message: "Сотрудник не найден" });
  }
  db.prepare("INSERT INTO meta (key, value) VALUES ('payroll_default_employee', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
    .run(id);
  res.json({ ok: true, defaultEmployeeId: id || null });
});

// ---------- Начисления ----------
router.get("/entries", (req, res) => {
  const where = [];
  const params = [];
  if (req.query.employeeId) { where.push("e.employee_id = ?"); params.push(req.query.employeeId); }
  // «Не разнесено» — работа есть, а кому платить, непонятно. В старом файле это
  // просто пустая клетка «Исполнитель», и таких строк набирается прилично.
  if (req.query.unassigned === "1") where.push("(e.employee_id IS NULL OR e.employee_id = '')");
  if (req.query.status) { where.push("e.status = ?"); params.push(req.query.status); }
  if (req.query.kind) { where.push("e.kind = ?"); params.push(req.query.kind); }
  if (req.query.shop) { where.push("e.shop = ?"); params.push(req.query.shop); }
  if (req.query.from) { where.push("e.created_at >= ?"); params.push(String(req.query.from)); }
  if (req.query.to) { where.push("e.created_at <= ?"); params.push(String(req.query.to) + "T23:59:59"); }
  // Архив по умолчанию скрыт: archived=1 — только архив, archived=all — вместе
  const arch = String(req.query.archived || "0");
  if (arch === "1") where.push("e.archived_at IS NOT NULL");
  else if (arch !== "all") where.push("e.archived_at IS NULL");
  if (req.query.includeCancelled !== "1") where.push("e.status != 'cancelled'");

  let rows = db.prepare(`
    SELECT e.*, o.display_number, o.kaspi_code, o.kaspi_creation_date, o.total_price, o.created_at AS order_created_at
    FROM payroll_entries e
    LEFT JOIN orders o ON o.id = e.order_id
    ${where.length ? "WHERE " + where.join(" AND ") : ""}
    ORDER BY o.display_number DESC, e.created_at DESC`).all(...params);

  // Поиск — по номеру заказа, коду Kaspi, артикулу и названию.
  // Сознательно фильтруем здесь, а не через lower(...) LIKE в SQL: у SQLite
  // встроенный lower() работает только с латиницей, поэтому запрос «макивара»
  // не находил «Макивара» — русские названия не искались вообще.
  if (req.query.q) {
    const q = String(req.query.q).trim().toLowerCase();
    if (q) {
      rows = rows.filter(r =>
        String(r.article || "").toLowerCase().includes(q) ||
        String(r.product_name || "").toLowerCase().includes(q) ||
        String(r.display_number == null ? "" : r.display_number).includes(q) ||
        String(r.kaspi_code || "").toLowerCase().includes(q));
    }
  }

  res.json(rows.map(r => entryToJson(r, r.order_id ? {
    display_number: r.display_number, kaspi_code: r.kaspi_code,
    kaspi_creation_date: r.kaspi_creation_date, created_at: r.order_created_at,
    total_price: r.total_price
  } : null)));
});

// Сколько всего лежит в архиве — чтобы убранное не выглядело «пропавшим»
router.get("/archive-stats", (req, res) => {
  const r = db.prepare(`SELECT COUNT(*) AS n, COALESCE(SUM(amount),0) AS s
                        FROM payroll_entries WHERE archived_at IS NOT NULL AND status != 'cancelled'`).get();
  const unpaid = db.prepare(`SELECT COUNT(*) AS n, COALESCE(SUM(amount),0) AS s
                             FROM payroll_entries WHERE archived_at IS NOT NULL AND status IN ('pending','payable')`).get();
  res.json({ count: r.n, sum: money(r.s), unpaidCount: unpaid.n, unpaidSum: money(unpaid.s) });
});

// История правок одной строки
router.get("/entries/:id/log", (req, res) => {
  const rows = db.prepare("SELECT * FROM payroll_entry_log WHERE entry_id = ? ORDER BY at DESC").all(req.params.id);
  res.json(rows.map(r => ({
    at: r.at, user: r.user, action: r.action, field: r.field,
    oldValue: r.old_value, newValue: r.new_value, comment: r.comment
  })));
});

// Начисление из записи «Производства» — вызывается сразу после назначения
// исполнителя. Повторный вызов не создаёт второе начисление.
router.post("/from-production/:productionId", (req, res) => {
  const prod = db.prepare("SELECT * FROM production WHERE id = ?").get(req.params.productionId);
  if (!prod) return res.status(404).json({ error: "not_found", message: "Запись производства не найдена" });
  if (!prod.employee_id) return res.status(400).json({ error: "no_employee", message: "У записи не назначен исполнитель" });

  const existing = db.prepare("SELECT * FROM payroll_entries WHERE production_id = ? AND status != 'cancelled'").get(prod.id);
  if (existing) return res.json(Object.assign(entryToJson(existing), { alreadyExists: true }));

  const order = prod.order_id ? db.prepare("SELECT * FROM orders WHERE id = ?").get(prod.order_id) : null;
  const { rate, found } = findRate(null, prod.article);
  // Количество: сначала из самого заказа (там оно настоящее и для Kaspi, и для
  // ручных УД), и только потом из записи производства. Наоборот нельзя:
  // у старых записей production.quantity по умолчанию равен 1 и перебил бы
  // реальное количество из заказа.
  const qty = num(order?.qty, 0) || num(prod.quantity, 0) || 1;
  const entry = insertEntry({
    employeeId: prod.employee_id, productionId: prod.id, orderId: prod.order_id,
    shop: prod.shop || order?.shop || null,
    article: prod.article, productName: prod.product_name,
    qty, rate, kind: "order", user: req.session.username
  });
  // Разнесение произошло здесь же — фиксируем, кто именно назначил исполнителя
  db.prepare("UPDATE payroll_entries SET assigned_by = ?, assigned_at = ? WHERE id = ?")
    .run(req.session.username, new Date().toISOString(), entry.id);
  logChange(entry.id, req.session.username, "assign", "employee", "не разнесено",
            db.prepare("SELECT name FROM employees WHERE id = ?").get(prod.employee_id)?.name || "", "Назначено в «Производстве»");
  logAudit({ user: req.session.username, action: "payroll_accrue", orderId: prod.order_id,
             comment: `${prod.product_name || prod.article}: ${money(entry.amount)} ₸` });
  res.json(Object.assign(entryToJson(entry), { rateFound: found }));
});

// Работа на запас: изделие уходит на склад, начисление создаётся сразу,
// но остаётся отложенным — платим, когда сами решим (так договорились).
router.post("/stock-production", (req, res) => {
  const b = req.body || {};
  if (!b.employeeId || !db.prepare("SELECT id FROM employees WHERE id = ?").get(b.employeeId)) {
    return res.status(400).json({ error: "no_employee", message: "Выберите исполнителя" });
  }
  const qty = num(b.qty, 1);
  if (qty <= 0) return res.status(400).json({ error: "bad_qty", message: "Количество должно быть больше нуля" });
  const { rate, found, item } = findRate(b.itemId, b.article);
  if (!found) return res.status(400).json({ error: "item_not_found", message: "Товар не найден в Справочнике — расценка берётся только оттуда" });

  const now = new Date().toISOString();
  const stockId = uid("ws");
  db.prepare(`INSERT INTO warehouse_stock (id, article, product_name, source, qty, consumed, created_at)
              VALUES (?,?,?,'overproduced',?,0,?)`)
    .run(stockId, item.article || "", item.name || item.kaspi_name || "", qty, now);

  const entry = insertEntry({
    employeeId: b.employeeId, warehouseStockId: stockId,
    article: item.article, productName: item.name || item.kaspi_name || "",
    qty, rate, kind: "stock", comment: str(b.comment), user: req.session.username
  });
  logAudit({ user: req.session.username, action: "payroll_stock_production",
             comment: `На склад: ${item.name || item.article} ×${qty}, начислено ${money(entry.amount)} ₸` });
  res.json({ ok: true, entry: entryToJson(entry), stockId });
});

// Ручное начисление (доработка, ремонт, нестандартная работа)
router.post("/entries", (req, res) => {
  const b = req.body || {};
  if (!b.employeeId || !db.prepare("SELECT id FROM employees WHERE id = ?").get(b.employeeId)) {
    return res.status(400).json({ error: "no_employee", message: "Выберите исполнителя" });
  }
  const { rate, found, item } = findRate(b.itemId, b.article);
  if (!found) return res.status(400).json({ error: "item_not_found", message: "Товар не найден в Справочнике — расценка берётся только оттуда" });
  const entry = insertEntry({
    employeeId: b.employeeId, article: item.article, productName: item.name || item.kaspi_name || "",
    qty: num(b.qty, 1), rate, kind: str(b.kind, 20) === "stock" ? "stock" : "order",
    comment: str(b.comment), user: req.session.username
  });
  res.json(entryToJson(entry));
});

// «Работа принята» — только после этого сумма попадает в выплату
router.post("/entries/:id/accept", (req, res) => {
  const e = db.prepare("SELECT * FROM payroll_entries WHERE id = ?").get(req.params.id);
  if (!e) return res.status(404).json({ error: "not_found" });
  if (e.status === "paid") return res.status(400).json({ error: "already_paid", message: "Работа уже оплачена" });
  if (e.status === "cancelled") return res.status(400).json({ error: "cancelled", message: "Начисление отменено" });
  if (num(e.rate) === 0) {
    return res.status(400).json({ error: "no_rate",
      message: `Не заполнена расценка труда для «${e.product_name || e.article}» — укажите её в Справочнике и создайте начисление заново` });
  }
  db.prepare("UPDATE payroll_entries SET status = 'payable', accepted_at = ?, accepted_by = ? WHERE id = ?")
    .run(new Date().toISOString(), req.session.username, e.id);
  logChange(e.id, req.session.username, "accept", "status", "отложено", "к выплате", null);
  logAudit({ user: req.session.username, action: "payroll_accept", comment: `${e.product_name || e.article}: ${money(e.amount)} ₸` });
  res.json(entryToJson(db.prepare("SELECT * FROM payroll_entries WHERE id = ?").get(e.id)));
});

// Разнесение работы на другого человека: сумма уже посчитана по расценке,
// меняется только исполнитель. Оплаченное не трогаем — там деньги уже ушли.
router.put("/entries/:id", (req, res) => {
  const e = db.prepare("SELECT * FROM payroll_entries WHERE id = ?").get(req.params.id);
  if (!e) return res.status(404).json({ error: "not_found" });
  if (e.status === "paid") return res.status(400).json({ error: "already_paid", message: "Работа уже оплачена — исполнителя не поменять" });

  const b = req.body || {};
  const updates = [];
  const params = [];
  const user = req.session.username;
  const now = new Date().toISOString();
  const changes = [];   // что записать в журнал после успешного UPDATE

  if (b.employeeId !== undefined) {
    const newId = b.employeeId || null;
    if (newId && !db.prepare("SELECT id FROM employees WHERE id = ?").get(newId)) {
      return res.status(400).json({ error: "no_employee", message: "Сотрудник не найден" });
    }
    if (newId !== e.employee_id) {
      const nameOf = (id) => id ? (db.prepare("SELECT name FROM employees WHERE id = ?").get(id)?.name || id) : "не разнесено";
      updates.push("employee_id = ?", "assigned_by = ?", "assigned_at = ?");
      params.push(newId, newId ? user : null, newId ? now : null);
      changes.push(["assign", "employee", nameOf(e.employee_id), nameOf(newId)]);
    }
  }
  // Количество можно поправить (например, сделали не всё) — сумму пересчитает сервер
  if (b.qty !== undefined) {
    const qty = num(b.qty);
    if (qty <= 0) return res.status(400).json({ error: "bad_qty", message: "Количество должно быть больше нуля" });
    if (qty !== num(e.qty)) {
      updates.push("qty = ?"); params.push(qty);
      changes.push(["edit", "qty", num(e.qty), qty]);
    }
  }
  // Расценку обычно берём из Справочника и не трогаем. Но в перенесённых из
  // старой таблицы строках она бывает неверной, а починить их иначе нечем —
  // поэтому правка разрешена и всегда попадает в журнал, с именем правившего.
  if (b.rate !== undefined) {
    const rate = num(b.rate);
    if (rate < 0) return res.status(400).json({ error: "bad_rate", message: "Расценка не может быть отрицательной" });
    if (rate !== num(e.rate)) {
      updates.push("rate = ?"); params.push(rate);
      changes.push(["edit", "rate", num(e.rate), rate]);
    }
  }
  if (b.comment !== undefined && str(b.comment) !== str(e.comment)) {
    updates.push("comment = ?"); params.push(str(b.comment));
    changes.push(["edit", "comment", e.comment || "", str(b.comment)]);
  }
  if (!updates.length) return res.json(entryToJson(e));

  // Сумму всегда пересчитываем сами — руками её вписать нельзя, чтобы
  // «кол-во × расценка» и итог не разъезжались
  const finalQty = b.qty !== undefined ? num(b.qty) : num(e.qty);
  const finalRate = b.rate !== undefined ? num(b.rate) : num(e.rate);
  const newAmount = money(finalQty * finalRate);
  if (newAmount !== money(e.amount)) changes.push(["edit", "amount", money(e.amount), newAmount]);
  updates.push("amount = ?"); params.push(newAmount);

  params.push(e.id);
  db.prepare(`UPDATE payroll_entries SET ${updates.join(", ")} WHERE id = ?`).run(...params);
  changes.forEach(([action, field, oldV, newV]) => logChange(e.id, user, action, field, oldV, newV, str(b.reason)));

  const updated = db.prepare("SELECT * FROM payroll_entries WHERE id = ?").get(e.id);
  logAudit({ user, action: "payroll_edit",
             comment: `${updated.product_name || updated.article}: ${changes.map(c => c[1]).join(", ")} → ${money(updated.amount)} ₸` });
  res.json(entryToJson(updated));
});

// Разнести пачку строк на одного человека — то самое «пусто = не разнесено»
router.post("/entries/assign", (req, res) => {
  const ids = Array.isArray(req.body?.ids) ? req.body.ids : [];
  const employeeId = req.body?.employeeId || null;
  if (!ids.length) return res.status(400).json({ error: "no_ids", message: "Не выбрано ни одной работы" });
  const emp = employeeId ? db.prepare("SELECT * FROM employees WHERE id = ?").get(employeeId) : null;
  if (employeeId && !emp) return res.status(400).json({ error: "no_employee", message: "Сотрудник не найден" });

  const user = req.session.username;
  const now = new Date().toISOString();
  let assigned = 0, skippedPaid = 0;
  for (const id of ids) {
    const e = db.prepare("SELECT * FROM payroll_entries WHERE id = ?").get(id);
    if (!e) continue;
    // Оплаченное не перекидываем: деньги уже выданы конкретному человеку
    if (e.status === "paid") { skippedPaid++; continue; }
    if (e.employee_id === employeeId) continue;
    const oldName = e.employee_id ? (db.prepare("SELECT name FROM employees WHERE id = ?").get(e.employee_id)?.name || "") : "не разнесено";
    db.prepare("UPDATE payroll_entries SET employee_id = ?, assigned_by = ?, assigned_at = ? WHERE id = ?")
      .run(employeeId, employeeId ? user : null, employeeId ? now : null, e.id);
    logChange(e.id, user, "assign", "employee", oldName, emp ? emp.name : "не разнесено", str(req.body?.reason));
    assigned++;
  }
  logAudit({ user, action: "payroll_assign_bulk",
             comment: `${emp ? emp.name : "снято"}: ${assigned} работ${skippedPaid ? `, пропущено оплаченных ${skippedPaid}` : ""}` });
  res.json({ ok: true, assigned, skippedPaid, employeeName: emp ? emp.name : "" });
});

// Архив: строку не удаляем, но убираем из рабочих списков и из подсчёта долга
router.post("/entries/archive", (req, res) => {
  const ids = Array.isArray(req.body?.ids) ? req.body.ids : [];
  if (!ids.length) return res.status(400).json({ error: "no_ids", message: "Не выбрано ни одной работы" });
  const toArchive = req.body?.archived !== false;
  const user = req.session.username;
  const now = new Date().toISOString();

  let count = 0, unpaid = 0;
  for (const id of ids) {
    const e = db.prepare("SELECT * FROM payroll_entries WHERE id = ?").get(id);
    if (!e) continue;
    if (toArchive && (e.status === "pending" || e.status === "payable")) unpaid++;
    db.prepare("UPDATE payroll_entries SET archived_at = ?, archived_by = ? WHERE id = ?")
      .run(toArchive ? now : null, toArchive ? user : null, e.id);
    logChange(e.id, user, toArchive ? "archive" : "unarchive", null, null, null, str(req.body?.reason));
    count++;
  }
  logAudit({ user, action: toArchive ? "payroll_archive" : "payroll_unarchive",
             comment: `Работ: ${count}${unpaid ? `, из них невыплаченных ${unpaid}` : ""}` });
  res.json({ ok: true, count, unpaid });
});

router.post("/entries/:id/cancel", (req, res) => {
  const e = db.prepare("SELECT * FROM payroll_entries WHERE id = ?").get(req.params.id);
  if (!e) return res.status(404).json({ error: "not_found" });
  if (e.status === "paid") return res.status(400).json({ error: "already_paid", message: "Оплаченное начисление отменить нельзя" });
  db.prepare("UPDATE payroll_entries SET status = 'cancelled', comment = ? WHERE id = ?")
    .run(str(req.body?.comment) || e.comment, e.id);
  logChange(e.id, req.session.username, "cancel", "status", e.status, "отменено", str(req.body?.comment));
  logAudit({ user: req.session.username, action: "payroll_cancel", comment: `${e.product_name || e.article}` });
  res.json({ ok: true });
});

// ---------- Сводка по сотрудникам ----------
router.get("/summary", (req, res) => {
  const employees = db.prepare("SELECT * FROM employees ORDER BY name").all();
  const rows = employees.map(emp => {
    const agg = (status, kind) => {
      const params = [emp.id, status];
      let sql = "SELECT COUNT(*) AS n, COALESCE(SUM(amount),0) AS s FROM payroll_entries WHERE employee_id = ? AND status = ? AND archived_at IS NULL";
      if (kind) { sql += " AND kind = ?"; params.push(kind); }
      const r = db.prepare(sql).all(...params)[0];
      return { count: r.n, sum: money(r.s) };
    };
    const pending = agg("pending");
    const payable = agg("payable");
    const paid = agg("paid");
    const paidOut = db.prepare("SELECT COALESCE(SUM(amount),0) AS s FROM payouts WHERE employee_id = ?").get(emp.id);
    return {
      employeeId: emp.id,
      name: emp.name,
      pendingCount: pending.count, pendingSum: pending.sum,       // отложено (работа не принята)
      pendingStockSum: agg("pending", "stock").sum,               // из них — на запас
      payableCount: payable.count, payableSum: payable.sum,       // к выплате
      paidCount: paid.count, paidSum: paid.sum,                   // всего начислено и выплачено
      payoutsSum: money(paidOut.s)                                // фактически выдано на руки (после вычетов)
    };
  });
  const totals = rows.reduce((acc, r) => ({
    pendingSum: money(acc.pendingSum + r.pendingSum),
    payableSum: money(acc.payableSum + r.payableSum),
    paidSum: money(acc.paidSum + r.paidSum),
    payoutsSum: money(acc.payoutsSum + r.payoutsSum)
  }), { pendingSum: 0, payableSum: 0, paidSum: 0, payoutsSum: 0 });
  res.json({ employees: rows, totals });
});

// Выплаты по месяцам — как в вашей таблице: строки месяцы, столбцы люди.
// Долгом считается всё принятое и отложенное, что ещё не выплачено.
router.get("/by-months", (req, res) => {
  const entries = db.prepare(`SELECT e.*, em.name AS emp_name FROM payroll_entries e
                              LEFT JOIN employees em ON em.id = e.employee_id
                              WHERE e.status != 'cancelled' AND e.archived_at IS NULL`).all();
  const months = new Map();
  const debts = new Map();
  const people = new Set();
  let paidTotal = 0, debtTotal = 0, undistributed = 0;

  for (const e of entries) {
    const name = e.emp_name || "не разнесено";
    const amount = num(e.amount);
    if (!e.employee_id || !e.emp_name) { undistributed += amount; continue; }
    people.add(name);
    if (e.status === "paid") {
      const when = String(e.paid_at || e.accepted_at || e.created_at || "").slice(0, 7);
      if (!months.has(when)) months.set(when, new Map());
      const m = months.get(when);
      m.set(name, money((m.get(name) || 0) + amount));
      paidTotal += amount;
    } else {
      debts.set(name, money((debts.get(name) || 0) + amount));
      debtTotal += amount;
    }
  }

  const MONTH_NAMES = ["январь","февраль","март","апрель","май","июнь","июль","август","сентябрь","октябрь","ноябрь","декабрь"];
  res.json({
    people: Array.from(people).sort(),
    months: Array.from(months.entries()).sort().map(([key, m]) => {
      const mm = parseInt(key.slice(5, 7), 10);
      return {
        key,
        label: `${MONTH_NAMES[mm - 1] || key} ${key.slice(0, 4)}`,
        byPerson: Object.fromEntries(m),
        total: money(Array.from(m.values()).reduce((s, v) => s + v, 0))
      };
    }),
    debts: Array.from(debts.entries()).map(([name, sum]) => ({ name, sum })).sort((a, b) => b.sum - a.sum),
    totals: { paid: money(paidTotal), debt: money(debtTotal), undistributed: money(undistributed) }
  });
});

// ---------- Выплаты ----------
router.post("/payouts", (req, res) => {
  const b = req.body || {};
  const emp = b.employeeId ? db.prepare("SELECT * FROM employees WHERE id = ?").get(b.employeeId) : null;
  if (!emp) return res.status(400).json({ error: "no_employee", message: "Выберите сотрудника" });

  // Берём только принятые работы: что не принято — в выплату не попадает
  let entries;
  if (Array.isArray(b.entryIds) && b.entryIds.length) {
    const ph = b.entryIds.map(() => "?").join(",");
    entries = db.prepare(`SELECT * FROM payroll_entries WHERE id IN (${ph}) AND employee_id = ? AND status = 'payable'`)
      .all(...b.entryIds, emp.id);
  } else {
    entries = db.prepare("SELECT * FROM payroll_entries WHERE employee_id = ? AND status = 'payable'").all(emp.id);
  }
  if (!entries.length) return res.status(400).json({ error: "nothing_to_pay", message: "Нет принятых работ к выплате" });

  const deductions = Array.isArray(b.deductions) ? b.deductions.filter(d => num(d.amount) > 0) : [];
  const accrued = money(entries.reduce((s, e) => s + num(e.amount), 0));
  const deductionsTotal = money(deductions.reduce((s, d) => s + num(d.amount), 0));
  if (deductionsTotal > accrued) {
    return res.status(400).json({ error: "deductions_too_big",
      message: `Вычеты (${deductionsTotal}) больше начисленного (${accrued}) — проверьте суммы` });
  }
  const amount = money(accrued - deductionsTotal);

  const now = new Date().toISOString();
  const numberRow = db.prepare("SELECT MAX(number) AS n FROM payouts").get();
  const id = uid("po");
  db.prepare(`INSERT INTO payouts (id, number, employee_id, accrued, deductions_total, amount, comment, created_by, created_at)
              VALUES (?,?,?,?,?,?,?,?,?)`)
    .run(id, (numberRow && numberRow.n ? numberRow.n : 0) + 1, emp.id, accrued, deductionsTotal, amount,
         str(b.comment), req.session.username, now);

  const insD = db.prepare("INSERT INTO payout_deductions (id, payout_id, kind, amount, comment) VALUES (?,?,?,?,?)");
  deductions.forEach(d => insD.run(uid("ded"), id, str(d.kind, 60) || "прочее", money(d.amount), str(d.comment)));

  const upd = db.prepare("UPDATE payroll_entries SET status = 'paid', paid_at = ?, payout_id = ? WHERE id = ?");
  entries.forEach(e => upd.run(now, id, e.id));

  logAudit({ user: req.session.username, action: "payroll_payout",
             comment: `${emp.name}: начислено ${accrued}, вычеты ${deductionsTotal}, к выдаче ${amount}` });
  res.json({ ok: true, id, accrued, deductionsTotal, amount, entries: entries.length });
});

router.get("/payouts", (req, res) => {
  const where = [];
  const params = [];
  if (req.query.employeeId) { where.push("employee_id = ?"); params.push(req.query.employeeId); }
  const rows = db.prepare(`SELECT * FROM payouts ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY created_at DESC LIMIT 200`).all(...params);
  res.json(rows.map(r => {
    const emp = db.prepare("SELECT name FROM employees WHERE id = ?").get(r.employee_id);
    return {
      id: r.id, number: r.number, employeeId: r.employee_id, employeeName: emp ? emp.name : "",
      accrued: num(r.accrued), deductionsTotal: num(r.deductions_total), amount: num(r.amount),
      comment: r.comment, createdBy: r.created_by, createdAt: r.created_at
    };
  }));
});

router.get("/payouts/:id", (req, res) => {
  const r = db.prepare("SELECT * FROM payouts WHERE id = ?").get(req.params.id);
  if (!r) return res.status(404).json({ error: "not_found" });
  const emp = db.prepare("SELECT name FROM employees WHERE id = ?").get(r.employee_id);
  res.json({
    id: r.id, number: r.number, employeeName: emp ? emp.name : "",
    accrued: num(r.accrued), deductionsTotal: num(r.deductions_total), amount: num(r.amount),
    comment: r.comment, createdBy: r.created_by, createdAt: r.created_at,
    deductions: db.prepare("SELECT * FROM payout_deductions WHERE payout_id = ?").all(r.id)
      .map(d => ({ kind: d.kind, amount: num(d.amount), comment: d.comment })),
    entries: db.prepare("SELECT * FROM payroll_entries WHERE payout_id = ?").all(r.id).map(entryToJson)
  });
});

export default router;

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

function entryToJson(e) {
  const emp = e.employee_id ? db.prepare("SELECT name FROM employees WHERE id = ?").get(e.employee_id) : null;
  return {
    id: e.id,
    employeeId: e.employee_id,
    employeeName: emp ? emp.name : "",
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
  if (req.query.employeeId) { where.push("employee_id = ?"); params.push(req.query.employeeId); }
  if (req.query.status) { where.push("status = ?"); params.push(req.query.status); }
  if (req.query.kind) { where.push("kind = ?"); params.push(req.query.kind); }
  if (req.query.shop) { where.push("shop = ?"); params.push(req.query.shop); }
  if (req.query.q) {
    where.push("(lower(article) LIKE ? OR lower(product_name) LIKE ?)");
    const like = "%" + String(req.query.q).toLowerCase() + "%";
    params.push(like, like);
  }
  if (req.query.from) { where.push("created_at >= ?"); params.push(String(req.query.from)); }
  if (req.query.to) { where.push("created_at <= ?"); params.push(String(req.query.to) + "T23:59:59"); }
  if (req.query.includeCancelled !== "1") where.push("status != 'cancelled'");
  const rows = db.prepare(`SELECT * FROM payroll_entries ${where.length ? "WHERE " + where.join(" AND ") : ""}
                           ORDER BY created_at DESC`).all(...params);
  res.json(rows.map(entryToJson));
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

  if (b.employeeId) {
    if (!db.prepare("SELECT id FROM employees WHERE id = ?").get(b.employeeId)) {
      return res.status(400).json({ error: "no_employee", message: "Сотрудник не найден" });
    }
    updates.push("employee_id = ?"); params.push(b.employeeId);
  }
  // Количество можно поправить (например, сделали не всё) — сумму пересчитает сервер
  if (b.qty !== undefined) {
    const qty = num(b.qty);
    if (qty <= 0) return res.status(400).json({ error: "bad_qty", message: "Количество должно быть больше нуля" });
    updates.push("qty = ?", "amount = ?");
    params.push(qty, money(qty * num(e.rate)));
  }
  if (b.comment !== undefined) { updates.push("comment = ?"); params.push(str(b.comment)); }
  if (!updates.length) return res.json(entryToJson(e));

  params.push(e.id);
  db.prepare(`UPDATE payroll_entries SET ${updates.join(", ")} WHERE id = ?`).run(...params);
  const updated = db.prepare("SELECT * FROM payroll_entries WHERE id = ?").get(e.id);
  logAudit({ user: req.session.username, action: "payroll_reassign",
             comment: `${updated.product_name || updated.article}: ${money(updated.amount)} ₸` });
  res.json(entryToJson(updated));
});

router.post("/entries/:id/cancel", (req, res) => {
  const e = db.prepare("SELECT * FROM payroll_entries WHERE id = ?").get(req.params.id);
  if (!e) return res.status(404).json({ error: "not_found" });
  if (e.status === "paid") return res.status(400).json({ error: "already_paid", message: "Оплаченное начисление отменить нельзя" });
  db.prepare("UPDATE payroll_entries SET status = 'cancelled', comment = ? WHERE id = ?")
    .run(str(req.body?.comment) || e.comment, e.id);
  logAudit({ user: req.session.username, action: "payroll_cancel", comment: `${e.product_name || e.article}` });
  res.json({ ok: true });
});

// ---------- Сводка по сотрудникам ----------
router.get("/summary", (req, res) => {
  const employees = db.prepare("SELECT * FROM employees ORDER BY name").all();
  const rows = employees.map(emp => {
    const agg = (status, kind) => {
      const params = [emp.id, status];
      let sql = "SELECT COUNT(*) AS n, COALESCE(SUM(amount),0) AS s FROM payroll_entries WHERE employee_id = ? AND status = ?";
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

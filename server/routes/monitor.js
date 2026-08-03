import express from "express";
import { db, logAudit } from "../db.js";
import { requireAuth, requirePermission, currentEmployeeId } from "../middleware/auth.js";

const router = express.Router();
router.use(requireAuth);
router.use(requirePermission("monitor"));

function uid(prefix) { return prefix + "_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }
function num(v, def = 0) { const n = Number(v); return Number.isFinite(n) ? n : def; }

// Монитор специально отдаёт МИНИМУМ данных: название, артикул, количество,
// магазин и расценка за свою работу. Ни закупки, ни продажной цены, ни маржи —
// забивщику это видеть незачем.
function toCard(prod, entry) {
  const order = prod.order_id ? db.prepare("SELECT display_number, shop, qty FROM orders WHERE id = ?").get(prod.order_id) : null;
  const item = prod.article ? db.prepare("SELECT labor_rate, photo FROM price_items WHERE article = ?").get(prod.article) : null;
  const qty = num(order?.qty, 0) || num(prod.quantity, 0) || 1;
  const rate = item ? num(item.labor_rate) : 0;
  return {
    id: prod.id,
    orderNumber: order ? order.display_number : null,
    shop: order ? order.shop : prod.shop,
    article: prod.article,
    productName: prod.product_name,
    photo: item ? item.photo : null,
    qty,
    rate,
    amount: Math.round(rate * qty * 100) / 100,
    status: entry ? (entry.status === "paid" ? "paid" : (entry.status === "payable" ? "confirmed" : (entry.reported_done ? "reported" : "in_work"))) : "free",
    reportedAt: entry ? entry.reported_at : null,
    reportedWeight: entry ? entry.reported_weight : null,
    managerComment: prod.manager_comment,
    entryId: entry ? entry.id : null
  };
}

// Свободные заказы — только те, что менеджер отправил в монитор
router.get("/free", (req, res) => {
  const me = currentEmployeeId(req);
  const rows = db.prepare(`SELECT * FROM production WHERE decision IS NULL AND published = 1
                           ORDER BY published_at, created_at`).all();
  // Адресные заказы показываем только тому, кому отправили
  const visible = rows.filter(r => !r.published_for || r.published_for === me);
  res.json(visible.map(r => Object.assign(toCard(r, null), {
    publishedAt: r.published_at,
    forMe: !!r.published_for,
    managerComment: r.manager_comment
  })));
});

// Мои работы
router.get("/mine", (req, res) => {
  const employeeId = currentEmployeeId(req);
  if (!employeeId) return res.json({ employeeLinked: false, items: [], totals: { inWork: 0, reported: 0, confirmed: 0, paid: 0 } });

  const rows = db.prepare("SELECT * FROM production WHERE employee_id = ? ORDER BY created_at DESC LIMIT 200").all(employeeId);
  const items = rows.map(r => {
    const entry = db.prepare("SELECT * FROM payroll_entries WHERE production_id = ? AND status != 'cancelled'").get(r.id);
    return toCard(r, entry);
  });
  const sum = (st) => items.filter(i => i.status === st).reduce((s, i) => s + i.amount, 0);
  res.json({
    employeeLinked: true,
    items,
    totals: {
      inWork: Math.round(sum("in_work") * 100) / 100,
      reported: Math.round(sum("reported") * 100) / 100,
      confirmed: Math.round(sum("confirmed") * 100) / 100,
      paid: Math.round(sum("paid") * 100) / 100
    }
  });
});

// «Беру себе» — заказ закрепляется и сразу создаётся начисление,
// но к выплате оно пойдёт только после подтверждения менеджера
router.post("/take/:productionId", (req, res) => {
  // Сначала проверяем сам заказ: занят — значит занят, кто бы ни нажал.
  // Иначе двое видели бы разные причины отказа по одному и тому же заказу.
  const prod = db.prepare("SELECT * FROM production WHERE id = ?").get(req.params.productionId);
  if (!prod) return res.status(404).json({ error: "not_found", message: "Заказ не найден" });
  if (prod.decision) {
    const emp = prod.employee_id ? db.prepare("SELECT name FROM employees WHERE id = ?").get(prod.employee_id) : null;
    return res.status(400).json({ error: "already_taken", message: emp ? `Заказ уже взял(а) ${emp.name}` : "Заказ уже разобран" });
  }

  const employeeId = currentEmployeeId(req);
  if (!employeeId) return res.status(400).json({ error: "no_employee", message: "Ваш логин не привязан к сотруднику — попросите администратора" });

  const now = new Date().toISOString();
  db.prepare("UPDATE production SET decision = 'assigned', employee_id = ?, resolved_at = ? WHERE id = ?")
    .run(employeeId, now, prod.id);

  const order = prod.order_id ? db.prepare("SELECT * FROM orders WHERE id = ?").get(prod.order_id) : null;
  const item = prod.article ? db.prepare("SELECT labor_rate FROM price_items WHERE article = ?").get(prod.article) : null;
  const qty = num(order?.qty, 0) || num(prod.quantity, 0) || 1;
  const rate = item ? num(item.labor_rate) : 0;

  const exists = db.prepare("SELECT id FROM payroll_entries WHERE production_id = ? AND status != 'cancelled'").get(prod.id);
  if (!exists) {
    // Заказ взят самим забивщиком — он же и автор разноски, поэтому
    // assigned_by заполняем сразу, а не оставляем пустым
    const entryId = uid("pay");
    db.prepare(`INSERT INTO payroll_entries
      (id, employee_id, production_id, order_id, shop, article, product_name, qty, rate, amount, kind, status, created_by, created_at, reported_done, assigned_by, assigned_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,'order','pending',?,?,0,?,?)`)
      .run(entryId, employeeId, prod.id, prod.order_id, prod.shop || order?.shop || null,
           prod.article, prod.product_name, qty, rate, Math.round(rate * qty * 100) / 100,
           req.session.username, now, req.session.username, now);
    const empName = db.prepare("SELECT name FROM employees WHERE id = ?").get(employeeId)?.name || "";
    db.prepare(`INSERT INTO payroll_entry_log (id, entry_id, at, user, action, field, old_value, new_value, comment)
                VALUES (?,?,?,?,'assign','employee','не разнесено',?,?)`)
      .run(uid("plog"), entryId, now, req.session.username, empName, "Взял заказ в мониторе");
  }
  // Если это заявка на забивку сшитого чехла — сразу отмечаем на складе,
  // кто его забивает. Иначе изделие так и висело бы «сшито, не забито».
  if (prod.warehouse_stock_id) {
    db.prepare("UPDATE warehouse_stock SET stage = 'ready', filled_by = ?, filled_at = ?, fill_entry_id = COALESCE(fill_entry_id, ?) WHERE id = ?")
      .run(employeeId, now,
           db.prepare("SELECT id FROM payroll_entries WHERE production_id = ? AND status != 'cancelled'").get(prod.id)?.id || null,
           prod.warehouse_stock_id);
  }
  logAudit({ user: req.session.username, action: "monitor_take", orderId: prod.order_id, comment: prod.product_name || prod.article });
  res.json({ ok: true });
});

// «Готово» — забивщик заявляет, что сделал. Деньги ждут подтверждения.
router.post("/done/:productionId", (req, res) => {
  const employeeId = currentEmployeeId(req);
  const prod = db.prepare("SELECT * FROM production WHERE id = ?").get(req.params.productionId);
  if (!prod) return res.status(404).json({ error: "not_found" });
  if (prod.employee_id !== employeeId) {
    return res.status(403).json({ error: "not_yours", message: "Это не ваш заказ" });
  }
  const entry = db.prepare("SELECT * FROM payroll_entries WHERE production_id = ? AND status != 'cancelled'").get(prod.id);
  if (!entry) return res.status(400).json({ error: "no_entry", message: "По заказу нет начисления — сообщите менеджеру" });
  if (entry.status !== "pending") return res.status(400).json({ error: "already", message: "Работа уже подтверждена менеджером" });

  const weight = num(req.body?.weight);
  db.prepare("UPDATE payroll_entries SET reported_done = 1, reported_at = ?, reported_by = ?, reported_weight = ? WHERE id = ?")
    .run(new Date().toISOString(), req.session.username, weight > 0 ? weight : null, entry.id);
  logAudit({ user: req.session.username, action: "monitor_done", orderId: prod.order_id, comment: prod.product_name || prod.article });
  res.json({ ok: true });
});

export default router;

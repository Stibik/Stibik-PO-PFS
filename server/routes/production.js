import express from "express";
import { db, logAudit } from "../db.js";
import { requireAuth } from "../middleware/auth.js";

const router = express.Router();
router.use(requireAuth);

function rowToProduction(row, order) {
  return {
    id: row.id,
    orderId: row.order_id,
    article: row.article,
    productName: row.product_name,
    decision: row.decision,
    employeeId: row.employee_id,
    paid: !!row.paid,
    warehouseStockId: row.warehouse_stock_id,
    createdAt: row.created_at,
    resolvedAt: row.resolved_at,
    order: order ? {
      displayNumber: order.display_number,
      shop: order.shop,
      kaspiCode: order.kaspi_code,
      kaspiStatus: order.kaspi_status,
      deliveryState: order.delivery_state
    } : null
  };
}

// Список записей производства. По умолчанию — всё; ?resolved=false — только
// ещё не решённые (это и есть очередь "ждёт решения" для интерфейса).
router.get("/", (req, res) => {
  const { resolved } = req.query;
  let rows;
  if (resolved === "false") rows = db.prepare("SELECT * FROM production WHERE decision IS NULL ORDER BY created_at ASC").all();
  else if (resolved === "true") rows = db.prepare("SELECT * FROM production WHERE decision IS NOT NULL ORDER BY resolved_at DESC").all();
  else rows = db.prepare("SELECT * FROM production ORDER BY created_at DESC").all();

  const result = rows.map(row => {
    const order = db.prepare("SELECT * FROM orders WHERE id = ?").get(row.order_id);
    return rowToProduction(row, order);
  });
  res.json(result);
});

// Есть ли на виртуальном складе подходящий товар (по артикулу) для этой записи
router.get("/:id/warehouse-match", (req, res) => {
  const prod = db.prepare("SELECT * FROM production WHERE id = ?").get(req.params.id);
  if (!prod) return res.status(404).json({ error: "not_found" });
  if (!prod.article) return res.json({ match: null });
  const match = db.prepare(
    "SELECT * FROM warehouse_stock WHERE article = ? AND consumed = 0 ORDER BY created_at ASC LIMIT 1"
  ).get(prod.article);
  res.json({
    match: match ? {
      id: match.id, productName: match.product_name, source: match.source,
      sourceOrderId: match.source_order_id, createdAt: match.created_at
    } : null
  });
});

// Принять решение по заказу: списать с остатков / присвоить исполнителя / перекрыть возвратом
router.post("/:id/resolve", (req, res) => {
  const prod = db.prepare("SELECT * FROM production WHERE id = ?").get(req.params.id);
  if (!prod) return res.status(404).json({ error: "not_found" });
  if (prod.decision) return res.status(400).json({ error: "already_resolved", message: "Решение уже принято" });

  const { decision, employeeId, warehouseStockId } = req.body || {};
  if (!["stock", "assigned", "return_offset"].includes(decision)) {
    return res.status(400).json({ error: "invalid_decision" });
  }
  const now = new Date().toISOString();

  if (decision === "assigned") {
    if (!employeeId) return res.status(400).json({ error: "employee_required", message: "Выберите сотрудника" });
    db.prepare("UPDATE production SET decision=?, employee_id=?, resolved_at=? WHERE id=?")
      .run(decision, employeeId, now, prod.id);

  } else if (decision === "return_offset") {
    // Перекрыто возвратом — труда не было, платить некому, сразу "оплачено"
    db.prepare("UPDATE production SET decision=?, paid=1, resolved_at=? WHERE id=?")
      .run(decision, now, prod.id);

  } else {
    // decision === "stock" — списываем конкретную позицию склада (или ищем сами по артикулу)
    const stock = warehouseStockId
      ? db.prepare("SELECT * FROM warehouse_stock WHERE id = ? AND consumed = 0").get(warehouseStockId)
      : (prod.article
          ? db.prepare("SELECT * FROM warehouse_stock WHERE article = ? AND consumed = 0 ORDER BY created_at ASC LIMIT 1").get(prod.article)
          : null);
    if (!stock) {
      return res.status(400).json({ error: "no_stock", message: "На складе не найдено подходящей позиции для списания" });
    }
    db.prepare("UPDATE warehouse_stock SET consumed=1, consumed_by_order_id=? WHERE id=?").run(prod.order_id, stock.id);
    db.prepare("UPDATE production SET decision=?, warehouse_stock_id=?, resolved_at=? WHERE id=?")
      .run(decision, stock.id, now, prod.id);
  }

  logAudit({ user: req.session.username, action: "production_resolve", orderId: prod.order_id, comment: decision });
  const updated = db.prepare("SELECT * FROM production WHERE id = ?").get(prod.id);
  const order = db.prepare("SELECT * FROM orders WHERE id = ?").get(prod.order_id);
  res.json(rowToProduction(updated, order));
});

// Отметить исполнителю оплачено/не оплачено (для будущей "Зарплаты", но нужно уже сейчас)
router.put("/:id/paid", (req, res) => {
  const prod = db.prepare("SELECT * FROM production WHERE id = ?").get(req.params.id);
  if (!prod) return res.status(404).json({ error: "not_found" });
  const paid = !!req.body?.paid;
  db.prepare("UPDATE production SET paid = ? WHERE id = ?").run(paid ? 1 : 0, req.params.id);
  res.json({ ok: true, paid });
});

export default router;

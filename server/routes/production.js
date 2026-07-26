import express from "express";
import { db, logAudit } from "../db.js";
import { requireAuth } from "../middleware/auth.js";

const router = express.Router();
router.use(requireAuth);

function genId(prefix) {
  return prefix + "_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

function logStageChange(productionId, fromStage, toStage, user, reason) {
  db.prepare(`INSERT INTO production_history (production_id, from_stage, to_stage, user, reason, created_at)
              VALUES (?, ?, ?, ?, ?, ?)`)
    .run(productionId, fromStage || null, toStage, user || "unknown", reason || null, new Date().toISOString());
}

function rowToProduction(row, order) {
  return {
    id: row.id,
    orderId: row.order_id,
    article: row.article,
    productName: row.product_name,
    quantity: row.quantity || 1,
    shop: row.shop,
    decision: row.decision,
    stage: row.stage || "pending",
    employeeId: row.employee_id,
    paid: !!row.paid,
    warehouseStockId: row.warehouse_stock_id,
    cancellationReason: row.cancellation_reason,
    createdAt: row.created_at,
    resolvedAt: row.resolved_at,
    archivedAt: row.archived_at,
    order: order ? {
      displayNumber: order.display_number,
      shop: order.shop,
      kaspiCode: order.kaspi_code,
      kaspiStatus: order.kaspi_status,
      deliveryState: order.delivery_state
    } : null
  };
}

// Список записей производства (не архивные). ?resolved=false — только "ждёт
// решения" (stage='pending') — это и есть основная очередь для интерфейса.
router.get("/", (req, res) => {
  const { resolved } = req.query;
  let rows;
  if (resolved === "false") rows = db.prepare("SELECT * FROM production WHERE stage = 'pending' ORDER BY created_at ASC").all();
  else if (resolved === "true") rows = db.prepare("SELECT * FROM production WHERE stage NOT IN ('pending','archived') ORDER BY resolved_at DESC").all();
  else rows = db.prepare("SELECT * FROM production WHERE stage != 'archived' ORDER BY created_at DESC").all();

  const result = rows.map(row => {
    const order = db.prepare("SELECT * FROM orders WHERE id = ?").get(row.order_id);
    return rowToProduction(row, order);
  });
  res.json(result);
});

// Архив — отдельно, с фильтрами (пункт 4 ТЗ): по номеру заказа, статусу,
// дате, магазину, исполнителю. Ничего не удаляется — это просто stage='archived'.
router.get("/archive", (req, res) => {
  const { search, shop, employeeId, dateFrom, dateTo } = req.query;
  let rows = db.prepare("SELECT * FROM production WHERE stage = 'archived' ORDER BY archived_at DESC").all();

  const result = rows.map(row => {
    const order = db.prepare("SELECT * FROM orders WHERE id = ?").get(row.order_id);
    return rowToProduction(row, order);
  }).filter(p => {
    if (shop && p.order?.shop !== shop) return false;
    if (employeeId && p.employeeId !== employeeId) return false;
    if (search) {
      const s = search.trim().toLowerCase();
      const num = String(p.order?.displayNumber || "").toLowerCase();
      const name = String(p.productName || "").toLowerCase();
      if (!num.includes(s) && !name.includes(s)) return false;
    }
    if (dateFrom && (!p.archivedAt || p.archivedAt.slice(0,10) < dateFrom)) return false;
    if (dateTo && (!p.archivedAt || p.archivedAt.slice(0,10) > dateTo)) return false;
    return true;
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
  let newStage;

  if (decision === "assigned") {
    if (!employeeId) return res.status(400).json({ error: "employee_required", message: "Выберите сотрудника" });
    newStage = "in_production";
    db.prepare("UPDATE production SET decision=?, employee_id=?, stage=?, resolved_at=? WHERE id=?")
      .run(decision, employeeId, newStage, now, prod.id);

  } else if (decision === "return_offset") {
    // Перекрыто возвратом — труда не было, платить некому, товар уже готов
    newStage = "ready";
    db.prepare("UPDATE production SET decision=?, paid=1, stage=?, resolved_at=? WHERE id=?")
      .run(decision, newStage, now, prod.id);

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
    newStage = "ready";
    db.prepare("UPDATE warehouse_stock SET consumed=1, consumed_by_order_id=? WHERE id=?").run(prod.order_id, stock.id);
    db.prepare("UPDATE production SET decision=?, warehouse_stock_id=?, stage=?, resolved_at=? WHERE id=?")
      .run(decision, stock.id, newStage, now, prod.id);
  }

  logStageChange(prod.id, prod.stage, newStage, req.session.username, decision);
  logAudit({ user: req.session.username, action: "production_resolve", orderId: prod.order_id, comment: decision });
  const updated = db.prepare("SELECT * FROM production WHERE id = ?").get(prod.id);
  const order = db.prepare("SELECT * FROM orders WHERE id = ?").get(prod.order_id);
  res.json(rowToProduction(updated, order));
});

// "Вернуть из производства" (пункт 3 ТЗ) — откат уже принятого решения.
// target: 'pending' (обратно в новые заказы) | 'stock' (на остатки) |
//         'cancelled' (отменить) | 'archived' (в архив)
// Если решение было "списано со склада" — обязательно возвращаем ту позицию
// склада обратно (иначе она "потеряется", будучи помеченной потреблённой).
router.post("/:id/revert", (req, res) => {
  const prod = db.prepare("SELECT * FROM production WHERE id = ?").get(req.params.id);
  if (!prod) return res.status(404).json({ error: "not_found" });

  const { target, reason } = req.body || {};
  if (!["pending", "stock", "cancelled", "archived"].includes(target)) {
    return res.status(400).json({ error: "invalid_target" });
  }
  const now = new Date().toISOString();

  // Если ранее списали со склада — освобождаем ту позицию обратно
  if (prod.warehouse_stock_id) {
    db.prepare("UPDATE warehouse_stock SET consumed=0, consumed_by_order_id=NULL WHERE id=?").run(prod.warehouse_stock_id);
  }

  let updates = "decision=NULL, employee_id=NULL, warehouse_stock_id=NULL, resolved_at=NULL, paid=0";
  let params = [];

  if (target === "pending") {
    updates += ", stage='pending'";
  } else if (target === "cancelled") {
    updates += ", stage='cancelled'";
  } else if (target === "archived") {
    updates += ", stage='archived', archived_at=?";
    params.push(now);
  } else if (target === "stock") {
    // Товар, привязанный к этой записи, физически существует — кладём его
    // как новую позицию виртуального склада, саму запись помечаем возвращённой.
    db.prepare(`INSERT INTO warehouse_stock (id, article, product_name, source, source_order_id, qty, consumed, location, status, created_at)
                VALUES (?, ?, ?, 'manual', ?, ?, 0, ?, 'available', ?)`)
      .run(genId("wh"), prod.article, prod.product_name, prod.order_id, prod.quantity || 1, "", now);
    updates += ", stage='returned_to_stock'";
  }

  db.prepare(`UPDATE production SET ${updates} WHERE id = ?`).run(...params, prod.id);
  logStageChange(prod.id, prod.stage, target === "stock" ? "returned_to_stock" : target, req.session.username, reason || "revert");
  logAudit({ user: req.session.username, action: "production_revert", orderId: prod.order_id, comment: `-> ${target}` });

  const updated = db.prepare("SELECT * FROM production WHERE id = ?").get(prod.id);
  const order = db.prepare("SELECT * FROM orders WHERE id = ?").get(prod.order_id);
  res.json(rowToProduction(updated, order));
});

// Отмена заказа с одной из 5 причин (пункт 5 ТЗ) — вызывается, когда Kaspi-
// статус заказа стал "отменён", и нужно решить, что физически с товаром.
router.post("/:id/cancel", (req, res) => {
  const prod = db.prepare("SELECT * FROM production WHERE id = ?").get(req.params.id);
  if (!prod) return res.status(404).json({ error: "not_found" });

  const REASONS = ["returned_to_stock", "not_made_yet", "already_made", "damaged_writeoff", "stays_with_customer"];
  const { reason } = req.body || {};
  if (!REASONS.includes(reason)) return res.status(400).json({ error: "invalid_reason" });
  const now = new Date().toISOString();

  // Если товар физически цел и может быть продан повторно — кладём на склад
  if (reason === "returned_to_stock" || reason === "already_made") {
    db.prepare(`INSERT INTO warehouse_stock (id, article, product_name, source, source_order_id, qty, consumed, location, status, created_at)
                VALUES (?, ?, ?, 'cancelled', ?, ?, 0, ?, 'available', ?)`)
      .run(genId("wh"), prod.article, prod.product_name, prod.order_id, prod.quantity || 1, "", now);
  }

  db.prepare("UPDATE production SET stage='cancelled', cancellation_reason=?, resolved_at=? WHERE id=?")
    .run(reason, now, prod.id);
  logStageChange(prod.id, prod.stage, "cancelled", req.session.username, reason);
  logAudit({ user: req.session.username, action: "production_cancel", orderId: prod.order_id, comment: reason });

  const updated = db.prepare("SELECT * FROM production WHERE id = ?").get(prod.id);
  const order = db.prepare("SELECT * FROM orders WHERE id = ?").get(prod.order_id);
  res.json(rowToProduction(updated, order));
});

// Восстановить из архива — обратно в очередь "ждёт решения"
router.post("/:id/restore", (req, res) => {
  const prod = db.prepare("SELECT * FROM production WHERE id = ?").get(req.params.id);
  if (!prod) return res.status(404).json({ error: "not_found" });
  const now = new Date().toISOString();
  db.prepare("UPDATE production SET stage='pending', archived_at=NULL, decision=NULL, resolved_at=NULL WHERE id=?").run(prod.id);
  logStageChange(prod.id, "archived", "pending", req.session.username, "restore");
  logAudit({ user: req.session.username, action: "production_restore", orderId: prod.order_id });
  const updated = db.prepare("SELECT * FROM production WHERE id = ?").get(prod.id);
  const order = db.prepare("SELECT * FROM orders WHERE id = ?").get(prod.order_id);
  res.json(rowToProduction(updated, order));
});

// История стадий конкретной записи (пункт 10 ТЗ)
router.get("/:id/history", (req, res) => {
  const rows = db.prepare("SELECT * FROM production_history WHERE production_id = ? ORDER BY id ASC").all(req.params.id);
  res.json(rows.map(r => ({
    id: r.id, fromStage: r.from_stage, toStage: r.to_stage,
    user: r.user, reason: r.reason, createdAt: r.created_at
  })));
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

import express from "express";
import { db, nextReceiptNumber, logAudit } from "../db.js";
import { requireAuth } from "../middleware/auth.js";
import { isValidNormalTransition, getNextStatus, STATUS_LABELS } from "../statusMachine.js";

const router = express.Router();
router.use(requireAuth);

function uid() {
  return "o" + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

// Приводим строку БД (snake_case) к формату, который ожидает фронтенд (camelCase)
function rowToOrder(row) {
  if (!row) return null;
  return {
    id: row.id,
    source: row.source,
    kaspiOrderId: row.kaspi_order_id,
    kaspiCode: row.kaspi_code,
    shop: row.shop,
    receiptNumber: row.receipt_number,
    displayNumber: row.display_number,
    article: row.article,
    name: row.name,
    qty: row.qty,
    note: row.note,
    photo: row.photo,
    receiveStatus: row.receive_status,
    orderDate: row.order_date,
    arrivedDate: row.arrived_date,
    buyPriceCny: row.buy_price_cny,
    buyPriceKzt: row.buy_price_kzt,
    deliveryPrice: row.delivery_price,
    salePrice: row.sale_price,
    category: row.category,
    actualQty: row.actual_qty,
    status: row.status,
    statusLabel: STATUS_LABELS[row.status] || row.status,
    kaspiStatus: row.kaspi_status,
    deliveryState: row.delivery_state,
    preOrder: !!row.pre_order,
    assembled: !!row.assembled,
    courierTransmissionDate: row.courier_transmission_date,
    courierHandoverDate: row.courier_handover_date,
    totalPrice: row.total_price,
    productName: row.product_name,
    productPhoto: row.product_photo,
    waybillUrl: row.waybill_url,
    printed: !!row.printed,
    printCount: row.print_count,
    lastPrintedAt: row.last_printed_at,
    lastPrintedBy: row.last_printed_by,
    claimNote: row.claim_note,
    claimResolved: !!row.claim_resolved,
    raw: row.raw ? JSON.parse(row.raw) : null,
    entriesRaw: row.entries_raw ? JSON.parse(row.entries_raw) : null,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

router.get("/", (req, res) => {
  const { source } = req.query;
  let rows;
  if (source) rows = db.prepare("SELECT * FROM orders WHERE source = ?").all(source);
  else rows = db.prepare("SELECT * FROM orders").all();
  res.json(rows.map(rowToOrder));
});

router.get("/:id", (req, res) => {
  const row = db.prepare("SELECT * FROM orders WHERE id = ?").get(req.params.id);
  if (!row) return res.status(404).json({ error: "not_found" });
  res.json(rowToOrder(row));
});

router.post("/", (req, res) => {
  const b = req.body || {};
  const id = uid();
  const now = new Date().toISOString();
  const receiptNumber = nextReceiptNumber();
  db.prepare(`INSERT INTO orders
    (id, source, receipt_number, article, name, qty, note, photo, receive_status, order_date,
     buy_price_cny, buy_price_kzt, delivery_price, sale_price, category, status, created_at, updated_at)
    VALUES (?, 'manual', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'preorder', ?, ?)`)
    .run(id, receiptNumber, b.article || "", b.name || "", b.qty || 0, b.note || "", b.photo || null,
         b.receiveStatus || b.status || "new", b.orderDate || now.slice(0,10),
         b.buyPriceCny || 0, b.buyPriceKzt || 0, b.deliveryPrice || 0, b.salePrice || 0, b.category || "", now, now);
  logAudit({ user: req.session.username, action: "create_order", orderId: id, newValue: b.name || b.article });
  const row = db.prepare("SELECT * FROM orders WHERE id = ?").get(id);
  res.json(rowToOrder(row));
});

router.put("/:id", (req, res) => {
  const row = db.prepare("SELECT * FROM orders WHERE id = ?").get(req.params.id);
  if (!row) return res.status(404).json({ error: "not_found" });
  const b = req.body || {};
  const now = new Date().toISOString();

  // Разрешаем точечно обновлять известные поля (без прямого изменения status —
  // для статуса есть отдельный маршрут /transition с проверкой правил перехода)
  const updates = [];
  const params = [];
  const map = {
    article: "article", name: "name", qty: "qty", note: "note", photo: "photo",
    receiveStatus: "receive_status", orderDate: "order_date",
    buyPriceCny: "buy_price_cny", buyPriceKzt: "buy_price_kzt", deliveryPrice: "delivery_price",
    salePrice: "sale_price", category: "category", actualQty: "actual_qty",
    claimNote: "claim_note", claimResolved: "claim_resolved", printed: "printed"
  };
  for (const [jsKey, col] of Object.entries(map)) {
    if (Object.prototype.hasOwnProperty.call(b, jsKey)) {
      updates.push(`${col} = ?`);
      let v = b[jsKey];
      if (typeof v === "boolean") v = v ? 1 : 0;
      params.push(v);
    }
  }
  // Дата прихода фиксируется автоматически один раз, в момент когда статус
  // впервые становится "пришло"/"проблема" — дальше не пересчитывается,
  // даже если статус потом поменяют обратно
  if (b.receiveStatus && (b.receiveStatus === "arrived" || b.receiveStatus === "problem") && !row.arrived_date) {
    updates.push("arrived_date = ?");
    params.push(now.slice(0, 10));
  }
  if (updates.length) {
    updates.push("updated_at = ?");
    params.push(now);
    params.push(req.params.id);
    db.prepare(`UPDATE orders SET ${updates.join(", ")} WHERE id = ?`).run(...params);
  }
  const updated = db.prepare("SELECT * FROM orders WHERE id = ?").get(req.params.id);
  res.json(rowToOrder(updated));
});

router.delete("/:id", (req, res) => {
  const row = db.prepare("SELECT * FROM orders WHERE id = ?").get(req.params.id);
  db.prepare("DELETE FROM orders WHERE id = ?").run(req.params.id);
  db.prepare("DELETE FROM cargo_places WHERE order_id = ?").run(req.params.id);
  logAudit({ user: req.session.username, action: "delete_order", orderId: req.params.id, oldValue: row?.name });
  res.json({ ok: true });
});

// ---------- Переход статуса ----------
router.post("/:id/transition", (req, res) => {
  const row = db.prepare("SELECT * FROM orders WHERE id = ?").get(req.params.id);
  if (!row) return res.status(404).json({ error: "not_found" });
  const { to, reason } = req.body || {};
  if (!to) return res.status(400).json({ error: "missing_target_status" });

  const from = row.status;
  const isAdmin = req.session.role === "admin";
  const normalOk = isValidNormalTransition(from, to);

  if (!normalOk) {
    // Прыжок через шаги — разрешён только админу и только с указанием причины
    if (!isAdmin) {
      return res.status(403).json({ error: "forbidden_transition", message: "Такой переход запрещён для вашей роли. Обратитесь к администратору." });
    }
    if (!reason || !reason.trim()) {
      return res.status(400).json({ error: "reason_required", message: "Для исправления статуса нужно указать причину" });
    }
  }

  // Блокировка: нельзя перейти в "ready" (готов к отгрузке), пока не сформировано
  // хотя бы одно грузовое место
  if (to === "ready") {
    const places = db.prepare("SELECT * FROM cargo_places WHERE order_id = ?").all(req.params.id);
    const formedCount = places.filter(p => p.formed).length;
    if (formedCount === 0) {
      return res.status(400).json({ error: "cargo_places_required", message: "Нельзя перевести в «Готов к отгрузке» — не сформировано ни одно грузовое место" });
    }
  }

  const now = new Date().toISOString();
  db.prepare("UPDATE orders SET status = ?, updated_at = ? WHERE id = ?").run(to, now, req.params.id);
  db.prepare(`INSERT INTO status_history (order_id, from_status, to_status, user, reason, is_correction, created_at)
              VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .run(req.params.id, from, to, req.session.username, reason || null, normalOk ? 0 : 1, now);
  logAudit({
    user: req.session.username, action: normalOk ? "status_transition" : "status_correction",
    orderId: req.params.id, oldValue: from, newValue: to, comment: reason || null
  });

  const updated = db.prepare("SELECT * FROM orders WHERE id = ?").get(req.params.id);
  res.json(rowToOrder(updated));
});

router.get("/:id/history", (req, res) => {
  const rows = db.prepare("SELECT * FROM status_history WHERE order_id = ? ORDER BY id ASC").all(req.params.id);
  res.json(rows.map(r => ({
    id: r.id, from: r.from_status, to: r.to_status, user: r.user,
    reason: r.reason, isCorrection: !!r.is_correction, createdAt: r.created_at
  })));
});

// ---------- Печать (с контролем повторной печати) ----------
router.post("/:id/print", (req, res) => {
  const row = db.prepare("SELECT * FROM orders WHERE id = ?").get(req.params.id);
  if (!row) return res.status(404).json({ error: "not_found" });
  const { confirmed, reason } = req.body || {};

  if (!confirmed) {
    return res.status(400).json({ error: "confirmation_required", message: "Нужно подтвердить, что документ фактически распечатан" });
  }
  if (row.printed && !reason) {
    return res.status(400).json({
      error: "reprint_reason_required",
      message: "Документ уже был распечатан. Укажите причину повторной печати.",
      lastPrintedAt: row.last_printed_at, lastPrintedBy: row.last_printed_by
    });
  }

  const now = new Date().toISOString();
  const isReprint = !!row.printed;
  db.prepare(`UPDATE orders SET printed = 1, print_count = print_count + 1,
              last_printed_at = ?, last_printed_by = ?, updated_at = ? WHERE id = ?`)
    .run(now, req.session.username, now, req.params.id);
  db.prepare(`INSERT INTO print_log (order_id, user, printed_at, is_reprint, reason) VALUES (?, ?, ?, ?, ?)`)
    .run(req.params.id, req.session.username, now, isReprint ? 1 : 0, reason || null);
  logAudit({ user: req.session.username, action: isReprint ? "reprint" : "print", orderId: req.params.id, comment: reason || null });

  // Автопереход packing -> label_printed при первой успешной печати
  if (!isReprint && row.status === "packing") {
    db.prepare("UPDATE orders SET status = 'label_printed', updated_at = ? WHERE id = ?").run(now, req.params.id);
    db.prepare(`INSERT INTO status_history (order_id, from_status, to_status, user, reason, created_at)
                VALUES (?, 'packing', 'label_printed', ?, 'Автоматически после печати', ?)`)
      .run(req.params.id, req.session.username, now);
  }

  const updated = db.prepare("SELECT * FROM orders WHERE id = ?").get(req.params.id);
  res.json(rowToOrder(updated));
});

router.get("/:id/print-log", (req, res) => {
  const rows = db.prepare("SELECT * FROM print_log WHERE order_id = ? ORDER BY id ASC").all(req.params.id);
  res.json(rows.map(r => ({
    id: r.id, user: r.user, printedAt: r.printed_at, isReprint: !!r.is_reprint, reason: r.reason
  })));
});

// ---------- Грузовые места ----------
router.get("/:id/cargo-places", (req, res) => {
  const rows = db.prepare("SELECT * FROM cargo_places WHERE order_id = ? ORDER BY place_number ASC").all(req.params.id);
  res.json(rows.map(r => ({
    id: r.id, placeNumber: r.place_number, name: r.name, formed: !!r.formed,
    labelPrinted: !!r.label_printed, formedAt: r.formed_at, formedBy: r.formed_by, comment: r.comment
  })));
});

router.post("/:id/cargo-places", (req, res) => {
  const order = db.prepare("SELECT * FROM orders WHERE id = ?").get(req.params.id);
  if (!order) return res.status(404).json({ error: "not_found" });
  const count = db.prepare("SELECT COUNT(*) as c FROM cargo_places WHERE order_id = ?").get(req.params.id).c;
  const id = "cp_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const { name, comment } = req.body || {};
  db.prepare(`INSERT INTO cargo_places (id, order_id, place_number, name, comment) VALUES (?, ?, ?, ?, ?)`)
    .run(id, req.params.id, count + 1, name || `Место ${count + 1}`, comment || null);
  logAudit({ user: req.session.username, action: "create_cargo_place", orderId: req.params.id, newValue: name || `Место ${count + 1}` });
  res.json({ ok: true, id });
});

router.put("/cargo-places/:placeId", (req, res) => {
  const place = db.prepare("SELECT * FROM cargo_places WHERE id = ?").get(req.params.placeId);
  if (!place) return res.status(404).json({ error: "not_found" });
  const { formed, labelPrinted, name, comment } = req.body || {};
  const now = new Date().toISOString();
  const updates = [];
  const params = [];
  if (name !== undefined) { updates.push("name = ?"); params.push(name); }
  if (comment !== undefined) { updates.push("comment = ?"); params.push(comment); }
  if (formed !== undefined) {
    updates.push("formed = ?"); params.push(formed ? 1 : 0);
    if (formed) { updates.push("formed_at = ?"); params.push(now); updates.push("formed_by = ?"); params.push(req.session.username); }
  }
  if (labelPrinted !== undefined) { updates.push("label_printed = ?"); params.push(labelPrinted ? 1 : 0); }
  if (updates.length) {
    params.push(req.params.placeId);
    db.prepare(`UPDATE cargo_places SET ${updates.join(", ")} WHERE id = ?`).run(...params);
  }
  logAudit({ user: req.session.username, action: "update_cargo_place", orderId: place.order_id, comment: JSON.stringify(req.body) });
  res.json({ ok: true });
});

router.delete("/cargo-places/:placeId", (req, res) => {
  const place = db.prepare("SELECT * FROM cargo_places WHERE id = ?").get(req.params.placeId);
  db.prepare("DELETE FROM cargo_places WHERE id = ?").run(req.params.placeId);
  if (place) logAudit({ user: req.session.username, action: "delete_cargo_place", orderId: place.order_id });
  res.json({ ok: true });
});

export default router;

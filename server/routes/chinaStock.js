import express from "express";
import { db, logAudit } from "../db.js";
import { requireAuth } from "../middleware/auth.js";

const router = express.Router();
router.use(requireAuth);

function uid(prefix) {
  return prefix + "_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}
function num(v, def = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : def;
}
function str(v, max = 500) {
  return String(v == null ? "" : v).replace(/[\r\n\t]+/g, " ").trim().slice(0, max);
}
// Ячейку приводим к одному виду, иначе «а-1-2», «А-1-2 » и «А-01-02» станут
// тремя разными местами, и инвентаризация будет врать
function normCell(v) {
  return str(v, 40).toUpperCase().replace(/\s+/g, "");
}

// Внутренний штрих-код. Артикулы китайских поставщиков повторяются и
// конфликтуют между собой, поэтому код всегда свой и уникальный.
function nextBarcode() {
  const row = db.prepare("SELECT value FROM meta WHERE key = 'china_barcode_seq'").get();
  let next = row ? parseInt(row.value, 10) + 1 : 1;
  if (!Number.isFinite(next) || next < 1) next = 1;
  // На всякий случай проверяем, что код действительно свободен
  while (db.prepare("SELECT id FROM china_stock WHERE barcode = ?").get("CN-" + String(next).padStart(6, "0"))) {
    next++;
  }
  const code = "CN-" + String(next).padStart(6, "0");
  db.prepare("INSERT INTO meta (key, value) VALUES ('china_barcode_seq', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
    .run(String(next));
  return code;
}

function logMove(stockId, kind, before, after, cellBefore, cellAfter, user, comment) {
  db.prepare(`INSERT INTO china_stock_moves (id, stock_id, kind, qty_before, qty_after, cell_before, cell_after, comment, user, created_at)
              VALUES (?,?,?,?,?,?,?,?,?,?)`)
    .run(uid("csm"), stockId, kind, before, after, cellBefore || null, cellAfter || null, comment || null, user, new Date().toISOString());
}

function rowToStock(r) {
  return {
    id: r.id,
    purchaseOrderId: r.purchase_order_id,
    article: r.article,
    name: r.name,
    photo: r.photo,
    category: r.category,
    barcode: r.barcode,
    cell: r.cell,
    qty: num(r.qty),
    unitPrice: num(r.unit_price),
    comment: r.comment,
    createdBy: r.created_by,
    createdAt: r.created_at,
    updatedAt: r.updated_at
  };
}

// ---------- Оприходование из закупки ----------
// Только внутри контура: основной склад, Справочник, Kaspi и производство
// не затрагиваются вообще (требование ТЗ 13 и вашей задачи).
router.post("/receive/:purchaseOrderId", (req, res) => {
  const po = db.prepare("SELECT * FROM china_purchase_orders WHERE id = ?").get(req.params.purchaseOrderId);
  if (!po) return res.status(404).json({ error: "not_found", message: "Закупка не найдена" });

  const lines = Array.isArray(req.body?.lines) ? req.body.lines : [];
  if (!lines.length) return res.status(400).json({ error: "no_lines", message: "Нечего оприходовать — не выбрано ни одной позиции" });

  const created = [];
  const now = new Date().toISOString();
  for (const line of lines) {
    const item = db.prepare("SELECT * FROM china_purchase_order_items WHERE id = ? AND purchase_order_id = ?")
      .get(line.itemId, po.id);
    if (!item) continue;
    const qty = num(line.qty);
    if (qty <= 0) continue;

    const already = db.prepare("SELECT COALESCE(SUM(qty),0) AS n FROM china_stock WHERE purchase_item_id = ?").get(item.id).n;
    const limit = num(item.qty_received) || num(item.qty_ordered);
    if (already + qty > limit) {
      return res.status(400).json({
        error: "too_much",
        message: `По позиции «${item.name || item.article}» уже оприходовано ${already} из ${limit} — больше принять нельзя`
      });
    }

    const id = uid("cst");
    const barcode = str(line.barcode, 60) || nextBarcode();
    if (db.prepare("SELECT id FROM china_stock WHERE barcode = ?").get(barcode)) {
      return res.status(400).json({ error: "barcode_taken", message: `Штрих-код ${barcode} уже занят другой позицией` });
    }
    db.prepare(`INSERT INTO china_stock
      (id, purchase_order_id, purchase_item_id, article, name, photo, category, barcode, cell, qty, unit_price, comment, created_by, created_at, updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(id, po.id, item.id, item.article, item.name, item.photo, item.category,
           barcode, normCell(line.cell), qty, num(item.unit_price), str(line.comment, 500),
           req.session.username, now, now);
    logMove(id, "receive", 0, qty, null, normCell(line.cell), req.session.username, `Закупка №${po.number}`);
    created.push(rowToStock(db.prepare("SELECT * FROM china_stock WHERE id = ?").get(id)));
  }

  if (!created.length) return res.status(400).json({ error: "no_lines", message: "Не указано количество ни по одной позиции" });
  logAudit({ user: req.session.username, action: "china_stock_receive", comment: `Закупка №${po.number}: оприходовано позиций ${created.length}` });
  res.json({ ok: true, created });
});

// ---------- Остатки ----------
router.get("/", (req, res) => {
  const where = [];
  const params = [];
  if (req.query.cell) { where.push("cell = ?"); params.push(normCell(req.query.cell)); }
  if (req.query.withZero !== "1") where.push("qty > 0");
  let rows = db.prepare(`SELECT * FROM china_stock ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY cell, name`).all(...params);

  const q = String(req.query.q || "").trim().toLowerCase();
  if (q) {
    rows = rows.filter(r =>
      String(r.name || "").toLowerCase().includes(q) ||
      String(r.article || "").toLowerCase().includes(q) ||
      String(r.barcode || "").toLowerCase().includes(q) ||
      String(r.cell || "").toLowerCase().includes(q));
  }
  res.json(rows.map(rowToStock));
});

// Сводка по ячейкам — для раскладки и для выбора, что пересчитывать
router.get("/cells", (req, res) => {
  const rows = db.prepare(`SELECT COALESCE(cell,'') AS cell, COUNT(*) AS positions, SUM(qty) AS units
                           FROM china_stock WHERE qty > 0 GROUP BY COALESCE(cell,'') ORDER BY cell`).all();
  res.json(rows.map(r => ({ cell: r.cell, positions: r.positions, units: num(r.units) })));
});

// Поиск по штрих-коду — под сканер: он «набирает» код и жмёт Enter
router.get("/by-barcode/:code", (req, res) => {
  const row = db.prepare("SELECT * FROM china_stock WHERE barcode = ?").get(str(req.params.code, 60));
  if (!row) return res.status(404).json({ error: "not_found", message: "Такой штрих-код на складе не найден" });
  res.json(rowToStock(row));
});

// Перемещение в другую ячейку и корректировка количества
router.put("/:id", (req, res) => {
  const row = db.prepare("SELECT * FROM china_stock WHERE id = ?").get(req.params.id);
  if (!row) return res.status(404).json({ error: "not_found" });
  const b = req.body || {};
  const newCell = b.cell === undefined ? row.cell : normCell(b.cell);
  const newQty = b.qty === undefined ? num(row.qty) : Math.max(0, num(b.qty));
  db.prepare("UPDATE china_stock SET cell = ?, qty = ?, comment = ?, updated_at = ? WHERE id = ?")
    .run(newCell, newQty, b.comment === undefined ? row.comment : str(b.comment, 500), new Date().toISOString(), row.id);

  if (newCell !== row.cell) logMove(row.id, "move", num(row.qty), newQty, row.cell, newCell, req.session.username, str(b.comment, 500));
  if (newQty !== num(row.qty)) logMove(row.id, "adjust", num(row.qty), newQty, row.cell, newCell, req.session.username, str(b.comment, 500));
  res.json(rowToStock(db.prepare("SELECT * FROM china_stock WHERE id = ?").get(row.id)));
});

// Списание: остаток не удаляем, а обнуляем — движение остаётся в истории
router.post("/:id/write-off", (req, res) => {
  const row = db.prepare("SELECT * FROM china_stock WHERE id = ?").get(req.params.id);
  if (!row) return res.status(404).json({ error: "not_found" });
  const qty = num(req.body?.qty, num(row.qty));
  if (qty <= 0 || qty > num(row.qty)) {
    return res.status(400).json({ error: "bad_qty", message: `Можно списать от 1 до ${num(row.qty)}` });
  }
  const after = num(row.qty) - qty;
  db.prepare("UPDATE china_stock SET qty = ?, updated_at = ? WHERE id = ?").run(after, new Date().toISOString(), row.id);
  logMove(row.id, "write_off", num(row.qty), after, row.cell, row.cell, req.session.username, str(req.body?.comment, 500));
  logAudit({ user: req.session.username, action: "china_stock_write_off", comment: `${row.name || row.article}: -${qty}` });
  res.json(rowToStock(db.prepare("SELECT * FROM china_stock WHERE id = ?").get(row.id)));
});

router.get("/:id/moves", (req, res) => {
  const rows = db.prepare("SELECT * FROM china_stock_moves WHERE stock_id = ? ORDER BY created_at DESC").all(req.params.id);
  res.json(rows.map(r => ({
    kind: r.kind, qtyBefore: num(r.qty_before), qtyAfter: num(r.qty_after),
    cellBefore: r.cell_before, cellAfter: r.cell_after,
    comment: r.comment, user: r.user, createdAt: r.created_at
  })));
});

// ---------- Инвентаризация ----------
// Открываем сессию, фиксируем ожидаемые остатки, вписываем факт.
// Остатки меняются ТОЛЬКО при завершении — чтобы недосчитанное на середине
// пути не превратилось в недостачу.
router.post("/inventory", (req, res) => {
  const open = db.prepare("SELECT id FROM china_inventory WHERE status = 'open'").get();
  if (open) return res.status(400).json({ error: "already_open", message: "Уже идёт инвентаризация — сначала завершите или отмените её", id: open.id });

  const cell = req.body?.cell ? normCell(req.body.cell) : null;
  const rows = cell
    ? db.prepare("SELECT * FROM china_stock WHERE qty > 0 AND cell = ? ORDER BY name").all(cell)
    : db.prepare("SELECT * FROM china_stock WHERE qty > 0 ORDER BY cell, name").all();
  if (!rows.length) return res.status(400).json({ error: "empty", message: "Нечего пересчитывать — на складе нет остатков" });

  const numberRow = db.prepare("SELECT MAX(number) AS n FROM china_inventory").get();
  const id = uid("cinv");
  const now = new Date().toISOString();
  db.prepare(`INSERT INTO china_inventory (id, number, status, cell_filter, started_at, user, comment)
              VALUES (?,?,'open',?,?,?,?)`)
    .run(id, (numberRow && numberRow.n ? numberRow.n : 0) + 1, cell, now, req.session.username, str(req.body?.comment, 500));

  const insert = db.prepare(`INSERT INTO china_inventory_items
    (id, inventory_id, stock_id, barcode, article, name, cell, expected_qty, counted_qty, updated_at)
    VALUES (?,?,?,?,?,?,?,?,NULL,?)`);
  rows.forEach(r => insert.run(uid("cii"), id, r.id, r.barcode, r.article, r.name, r.cell, num(r.qty), now));

  logAudit({ user: req.session.username, action: "china_inventory_start", comment: cell ? `Ячейка ${cell}` : "Весь склад" });
  res.json({ ok: true, id, positions: rows.length });
});

function inventoryPayload(inv) {
  const items = db.prepare("SELECT * FROM china_inventory_items WHERE inventory_id = ? ORDER BY cell, name").all(inv.id);
  return {
    id: inv.id,
    number: inv.number,
    status: inv.status,
    cellFilter: inv.cell_filter,
    startedAt: inv.started_at,
    finishedAt: inv.finished_at,
    user: inv.user,
    comment: inv.comment,
    counted: items.filter(i => i.counted_qty != null).length,
    total: items.length,
    items: items.map(i => ({
      id: i.id, stockId: i.stock_id, barcode: i.barcode, article: i.article, name: i.name, cell: i.cell,
      expectedQty: num(i.expected_qty),
      countedQty: i.counted_qty == null ? null : num(i.counted_qty),
      diff: i.counted_qty == null ? null : num(i.counted_qty) - num(i.expected_qty)
    }))
  };
}

router.get("/inventory/current", (req, res) => {
  const inv = db.prepare("SELECT * FROM china_inventory WHERE status = 'open' ORDER BY started_at DESC").get();
  if (!inv) return res.json({ exists: false });
  res.json(Object.assign({ exists: true }, inventoryPayload(inv)));
});

router.get("/inventory/:id", (req, res) => {
  const inv = db.prepare("SELECT * FROM china_inventory WHERE id = ?").get(req.params.id);
  if (!inv) return res.status(404).json({ error: "not_found" });
  res.json(inventoryPayload(inv));
});

// Проставить факт: по id строки или сразу по штрих-коду (сканером удобнее)
router.put("/inventory/:id/count", (req, res) => {
  const inv = db.prepare("SELECT * FROM china_inventory WHERE id = ?").get(req.params.id);
  if (!inv) return res.status(404).json({ error: "not_found" });
  if (inv.status !== "open") return res.status(400).json({ error: "closed", message: "Инвентаризация уже завершена" });

  const b = req.body || {};
  const row = b.itemId
    ? db.prepare("SELECT * FROM china_inventory_items WHERE id = ? AND inventory_id = ?").get(b.itemId, inv.id)
    : db.prepare("SELECT * FROM china_inventory_items WHERE barcode = ? AND inventory_id = ?").get(str(b.barcode, 60), inv.id);
  if (!row) return res.status(404).json({ error: "item_not_found", message: "Такой позиции нет в этой инвентаризации" });

  // increment=1 — режим сканера: каждое сканирование добавляет единицу
  const counted = b.increment
    ? num(row.counted_qty) + num(b.qty, 1)
    : Math.max(0, num(b.countedQty));
  db.prepare("UPDATE china_inventory_items SET counted_qty = ?, updated_at = ? WHERE id = ?")
    .run(counted, new Date().toISOString(), row.id);
  res.json({
    ok: true, itemId: row.id, countedQty: counted,
    expectedQty: num(row.expected_qty), diff: counted - num(row.expected_qty)
  });
});

// Завершение: непосчитанные позиции остаются как были, посчитанные — приводятся
// к факту, каждое изменение попадает в историю движений
router.post("/inventory/:id/finish", (req, res) => {
  const inv = db.prepare("SELECT * FROM china_inventory WHERE id = ?").get(req.params.id);
  if (!inv) return res.status(404).json({ error: "not_found" });
  if (inv.status !== "open") return res.status(400).json({ error: "closed", message: "Инвентаризация уже завершена" });

  const items = db.prepare("SELECT * FROM china_inventory_items WHERE inventory_id = ?").all(inv.id);
  let changed = 0, surplus = 0, shortage = 0;
  for (const i of items) {
    if (i.counted_qty == null) continue;
    const stock = db.prepare("SELECT * FROM china_stock WHERE id = ?").get(i.stock_id);
    if (!stock) continue;
    const before = num(stock.qty);
    const after = num(i.counted_qty);
    if (before === after) continue;
    db.prepare("UPDATE china_stock SET qty = ?, updated_at = ? WHERE id = ?").run(after, new Date().toISOString(), stock.id);
    logMove(stock.id, "inventory", before, after, stock.cell, stock.cell, req.session.username, `Инвентаризация №${inv.number}`);
    changed++;
    if (after > before) surplus += after - before; else shortage += before - after;
  }
  db.prepare("UPDATE china_inventory SET status = 'done', finished_at = ? WHERE id = ?").run(new Date().toISOString(), inv.id);
  logAudit({
    user: req.session.username, action: "china_inventory_finish",
    comment: `№${inv.number}: изменено позиций ${changed}, излишек ${surplus}, недостача ${shortage}`
  });
  res.json({ ok: true, changed, surplus, shortage, notCounted: items.filter(i => i.counted_qty == null).length });
});

router.post("/inventory/:id/cancel", (req, res) => {
  const inv = db.prepare("SELECT * FROM china_inventory WHERE id = ?").get(req.params.id);
  if (!inv) return res.status(404).json({ error: "not_found" });
  if (inv.status !== "open") return res.status(400).json({ error: "closed", message: "Инвентаризация уже завершена" });
  db.prepare("UPDATE china_inventory SET status = 'cancelled', finished_at = ? WHERE id = ?").run(new Date().toISOString(), inv.id);
  res.json({ ok: true });
});

router.get("/inventory", (req, res) => {
  const rows = db.prepare("SELECT * FROM china_inventory ORDER BY started_at DESC LIMIT 50").all();
  res.json(rows.map(r => ({
    id: r.id, number: r.number, status: r.status, cellFilter: r.cell_filter,
    startedAt: r.started_at, finishedAt: r.finished_at, user: r.user
  })));
});

export default router;

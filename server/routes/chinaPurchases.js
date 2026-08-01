import express from "express";
import { db, logAudit } from "../db.js";
import { requireAuth } from "../middleware/auth.js";

const router = express.Router();
router.use(requireAuth);

const STATUSES = ["ordered", "ready", "transit", "received", "cancelled"];
const STATUS_LABELS = {
  ordered: "Заказано", ready: "Готово к отправке", transit: "В пути",
  received: "Получено", cancelled: "Отменено"
};

function uid(prefix) {
  return prefix + "_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}
function today() {
  return new Date().toISOString().slice(0, 10);
}
function num(v, def = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : def;
}
function str(v, max = 500) {
  return String(v == null ? "" : v).replace(/[\r\n\t]+/g, " ").trim().slice(0, max);
}
function dateOrNull(v) {
  const s = String(v || "").trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null;
}
function daysBetween(fromDate, toDate) {
  if (!fromDate) return null;
  const a = new Date(fromDate + "T00:00:00");
  const b = toDate ? new Date(toDate + "T00:00:00") : new Date();
  if (isNaN(a) || isNaN(b)) return null;
  return Math.max(0, Math.round((b - a) / 86400000));
}

// Просрочка НЕ хранится отдельным статусом, а считается каждый раз (ТЗ 5):
// либо прошла плановая отправка, а фактической нет, либо прошёл плановый приход,
// а закупка ещё не получена.
function isOverdue(row) {
  if (row.status === "received" || row.status === "cancelled" || row.is_archived) return false;
  const now = today();
  if (row.plan_ship_date && !row.fact_ship_date && row.plan_ship_date < now) return true;
  if (row.plan_arrive_date && row.plan_arrive_date < now) return true;
  return false;
}

// Дни в пути: от фактической отправки до получения (или до сегодня, если ещё едет)
function daysInTransit(row) {
  if (!row.fact_ship_date) return null;
  return daysBetween(row.fact_ship_date, row.fact_receive_date || null);
}

function itemsOf(purchaseOrderId) {
  return db.prepare("SELECT * FROM china_purchase_order_items WHERE purchase_order_id = ? ORDER BY sort_order")
    .all(purchaseOrderId);
}

function rowToPurchase(row, opts = {}) {
  const items = opts.items || itemsOf(row.id);
  const supplier = row.supplier_id
    ? db.prepare("SELECT id, name FROM suppliers WHERE id = ?").get(row.supplier_id)
    : null;
  const sum = (field) => items.reduce((s, it) => s + num(it[field]), 0);
  return {
    id: row.id,
    number: row.number,
    supplierId: row.supplier_id,
    supplierName: supplier ? supplier.name : "",
    supplierOrderNo: row.supplier_order_no,
    channel: row.channel,
    orderDate: row.order_date,
    planShipDate: row.plan_ship_date,
    factShipDate: row.fact_ship_date,
    planArriveDate: row.plan_arrive_date,
    factReceiveDate: row.fact_receive_date,
    status: row.status,
    statusLabel: STATUS_LABELS[row.status] || row.status,
    overdue: isOverdue(row),
    daysInTransit: daysInTransit(row),
    currency: row.currency,
    rate: row.rate,
    totalAmount: num(row.total_amount),
    trackNo: row.track_no,
    link: row.link,
    comment: row.comment,
    attachment: row.attachment,
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    isArchived: !!row.is_archived,
    qtyOrdered: sum("qty_ordered"),
    qtyShipped: sum("qty_shipped"),
    qtyReceived: sum("qty_received"),
    itemCount: items.length,
    items: items.map(it => ({
      id: it.id,
      itemId: it.item_id,
      article: it.article,
      name: it.name,
      photo: it.photo,
      category: it.category,
      qtyOrdered: num(it.qty_ordered),
      qtyShipped: num(it.qty_shipped),
      qtyReceived: num(it.qty_received),
      unitPrice: num(it.unit_price),
      totalPrice: num(it.total_price),
      comment: it.comment,
      sortOrder: it.sort_order
    }))
  };
}

// Суммы считаются ТОЛЬКО на сервере — клиенту тут не верим (ТЗ 15)
function recalcTotals(purchaseOrderId) {
  const items = itemsOf(purchaseOrderId);
  let total = 0;
  for (const it of items) {
    const line = Math.round(num(it.qty_ordered) * num(it.unit_price) * 100) / 100;
    total += line;
    db.prepare("UPDATE china_purchase_order_items SET total_price = ? WHERE id = ?").run(line, it.id);
  }
  total = Math.round(total * 100) / 100;
  db.prepare("UPDATE china_purchase_orders SET total_amount = ? WHERE id = ?").run(total, purchaseOrderId);
  return total;
}

function writeHistory(purchaseOrderId, fromStatus, toStatus, user, comment) {
  db.prepare(`INSERT INTO china_purchase_history (id, purchase_order_id, from_status, to_status, user, comment, created_at)
              VALUES (?,?,?,?,?,?,?)`)
    .run(uid("cph"), purchaseOrderId, fromStatus, toStatus, user, comment || null, new Date().toISOString());
}

function nextPurchaseNumber() {
  const row = db.prepare("SELECT MAX(number) AS n FROM china_purchase_orders").get();
  return (row && row.n ? row.n : 0) + 1;
}

// Позиции переписываем целиком: объёмы маленькие, а так не бывает
// рассинхронизации между тем, что прислал клиент, и тем, что в базе
function replaceItems(purchaseOrderId, items) {
  const existing = itemsOf(purchaseOrderId);
  const byId = new Map(existing.map(it => [it.id, it]));
  db.prepare("DELETE FROM china_purchase_order_items WHERE purchase_order_id = ?").run(purchaseOrderId);
  const insert = db.prepare(`INSERT INTO china_purchase_order_items
    (id, purchase_order_id, item_id, article, name, photo, category,
     qty_ordered, qty_shipped, qty_received, unit_price, total_price, comment, sort_order)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  items.forEach((it, i) => {
    const id = it.id && byId.has(it.id) ? it.id : uid("cpi");
    const prev = byId.get(id);
    // Отправленное и полученное количество меняется только через свои действия,
    // а не через обычное редактирование позиции — иначе можно случайно
    // «получить» товар, просто поправив название
    const qtyShipped = prev ? num(prev.qty_shipped) : 0;
    const qtyReceived = prev ? num(prev.qty_received) : 0;
    insert.run(
      id, purchaseOrderId,
      it.itemId || null, str(it.article, 120), str(it.name, 300), str(it.photo, 400) || null,
      str(it.category, 120), num(it.qtyOrdered), qtyShipped, qtyReceived,
      num(it.unitPrice), 0, str(it.comment, 500), i
    );
  });
  recalcTotals(purchaseOrderId);
}

// ---------- Поставщики ----------
router.get("/suppliers", (req, res) => {
  const all = req.query.all === "1";
  const rows = db.prepare(
    all ? "SELECT * FROM suppliers ORDER BY name"
        : "SELECT * FROM suppliers WHERE is_active = 1 ORDER BY name"
  ).all();
  res.json(rows.map(r => ({
    id: r.id, name: r.name, contact: r.contact, phone: r.phone,
    link: r.link, comment: r.comment, isActive: r.is_active !== 0
  })));
});

router.post("/suppliers", (req, res) => {
  const name = str(req.body?.name, 200);
  if (!name) return res.status(400).json({ error: "name_required", message: "Укажите название поставщика" });
  const exists = db.prepare("SELECT id FROM suppliers WHERE lower(name) = lower(?)").get(name);
  if (exists) return res.status(400).json({ error: "duplicate", message: "Поставщик с таким названием уже есть" });
  const now = new Date().toISOString();
  const id = uid("sup");
  db.prepare(`INSERT INTO suppliers (id, name, contact, phone, link, comment, is_active, created_at, updated_at)
              VALUES (?,?,?,?,?,?,1,?,?)`)
    .run(id, name, str(req.body?.contact, 200), str(req.body?.phone, 100), str(req.body?.link, 400), str(req.body?.comment, 500), now, now);
  logAudit({ user: req.session.username, action: "supplier_create", comment: name });
  res.json({ ok: true, id, name });
});

router.put("/suppliers/:id", (req, res) => {
  const row = db.prepare("SELECT * FROM suppliers WHERE id = ?").get(req.params.id);
  if (!row) return res.status(404).json({ error: "not_found" });
  const name = str(req.body?.name, 200) || row.name;
  db.prepare(`UPDATE suppliers SET name = ?, contact = ?, phone = ?, link = ?, comment = ?, updated_at = ? WHERE id = ?`)
    .run(name, str(req.body?.contact, 200), str(req.body?.phone, 100), str(req.body?.link, 400), str(req.body?.comment, 500), new Date().toISOString(), row.id);
  res.json({ ok: true });
});

// Поставщика не удаляем физически — на него могут ссылаться старые закупки
router.post("/suppliers/:id/toggle-active", (req, res) => {
  const row = db.prepare("SELECT * FROM suppliers WHERE id = ?").get(req.params.id);
  if (!row) return res.status(404).json({ error: "not_found" });
  db.prepare("UPDATE suppliers SET is_active = ?, updated_at = ? WHERE id = ?")
    .run(row.is_active ? 0 : 1, new Date().toISOString(), row.id);
  res.json({ ok: true, isActive: !row.is_active });
});

// ---------- Выборка закупок с фильтрами ----------
function queryPurchases(q) {
  const where = [];
  const params = [];
  if (q.archived !== "1") where.push("po.is_archived = 0");
  if (q.status && STATUSES.includes(q.status)) { where.push("po.status = ?"); params.push(q.status); }
  if (q.supplierId) { where.push("po.supplier_id = ?"); params.push(q.supplierId); }
  if (dateOrNull(q.from)) { where.push("po.order_date >= ?"); params.push(dateOrNull(q.from)); }
  if (dateOrNull(q.to)) { where.push("po.order_date <= ?"); params.push(dateOrNull(q.to)); }
  const sql = `SELECT po.* FROM china_purchase_orders po
               ${where.length ? "WHERE " + where.join(" AND ") : ""}
               ORDER BY po.order_date DESC, po.number DESC`;
  let rows = db.prepare(sql).all(...params);

  // Поиск и категория проверяются по позициям — их удобнее отфильтровать здесь,
  // чем городить подзапросы: объёмы закупок небольшие
  const search = String(q.q || "").trim().toLowerCase();
  const category = String(q.category || "").trim();
  if (search || category) {
    rows = rows.filter(row => {
      const items = itemsOf(row.id);
      const okSearch = !search || items.some(it =>
        String(it.article || "").toLowerCase().includes(search) ||
        String(it.name || "").toLowerCase().includes(search)) ||
        String(row.track_no || "").toLowerCase().includes(search) ||
        String(row.supplier_order_no || "").toLowerCase().includes(search);
      const okCategory = !category || items.some(it => (it.category || "") === category);
      return okSearch && okCategory;
    });
  }
  if (q.overdue === "1") rows = rows.filter(isOverdue);
  return rows;
}

router.get("/", (req, res) => {
  const rows = queryPurchases(req.query);
  res.json(rows.map(r => rowToPurchase(r)));
});

// Показатели верхних карточек — считаются по тем же фильтрам, что и таблица (ТЗ 7)
router.get("/stats", (req, res) => {
  const q = Object.assign({}, req.query);
  delete q.status;
  delete q.overdue;
  const rows = queryPurchases(q).map(r => ({ row: r, data: rowToPurchase(r) }));

  const pick = (statuses) => rows.filter(x => statuses.includes(x.data.status));
  const agg = (list) => ({
    positions: list.reduce((s, x) => s + x.data.itemCount, 0),
    units: list.reduce((s, x) => s + x.data.qtyOrdered, 0),
    amount: Math.round(list.reduce((s, x) => s + x.data.totalAmount, 0) * 100) / 100,
    orders: list.length
  });

  const ordered = pick(["ordered", "ready"]);
  const transit = pick(["transit"]);
  const received = pick(["received"]);
  const active = rows.filter(x => !["received", "cancelled"].includes(x.data.status));

  const transitDays = transit.map(x => x.data.daysInTransit).filter(d => d != null);
  const monthStart = new Date().toISOString().slice(0, 7) + "-01";

  res.json({
    ordered: Object.assign(agg(ordered), {
      waitingShipment: ordered.filter(x => !x.data.factShipDate).length
    }),
    transit: Object.assign(agg(transit), {
      avgDays: transitDays.length ? Math.round(transitDays.reduce((s, d) => s + d, 0) / transitDays.length) : 0
    }),
    received: Object.assign(agg(received), {
      thisMonth: received.filter(x => (x.data.factReceiveDate || "") >= monthStart).length
    }),
    active: Object.assign(agg(active), {
      overdue: active.filter(x => x.data.overdue).length
    }),
    counts: {
      all: rows.length,
      ordered: pick(["ordered"]).length,
      ready: pick(["ready"]).length,
      transit: transit.length,
      received: received.length,
      cancelled: pick(["cancelled"]).length,
      overdue: rows.filter(x => x.data.overdue).length
    }
  });
});

router.get("/:id", (req, res) => {
  const row = db.prepare("SELECT * FROM china_purchase_orders WHERE id = ?").get(req.params.id);
  if (!row) return res.status(404).json({ error: "not_found", message: "Закупка не найдена" });
  const data = rowToPurchase(row);
  data.history = db.prepare("SELECT * FROM china_purchase_history WHERE purchase_order_id = ? ORDER BY created_at")
    .all(row.id)
    .map(h => ({
      fromStatus: h.from_status, toStatus: h.to_status,
      fromLabel: STATUS_LABELS[h.from_status] || h.from_status,
      toLabel: STATUS_LABELS[h.to_status] || h.to_status,
      user: h.user, comment: h.comment, createdAt: h.created_at
    }));
  res.json(data);
});

function validatePayload(body) {
  const items = Array.isArray(body?.items) ? body.items.filter(it => str(it?.name, 300) || str(it?.article, 120)) : [];
  if (!items.length) return { error: "no_items", message: "Добавьте хотя бы одну товарную позицию" };
  if (!items.some(it => num(it.qtyOrdered) > 0)) return { error: "no_qty", message: "Укажите количество хотя бы у одной позиции" };
  if (!body?.supplierId) return { error: "supplier_required", message: "Выберите поставщика" };
  if (!db.prepare("SELECT id FROM suppliers WHERE id = ?").get(body.supplierId)) {
    return { error: "supplier_not_found", message: "Поставщик не найден" };
  }
  if (!dateOrNull(body?.orderDate)) return { error: "order_date_required", message: "Укажите дату заказа" };
  return { items };
}

router.post("/", (req, res) => {
  const b = req.body || {};
  const check = validatePayload(b);
  if (check.error) return res.status(400).json({ error: check.error, message: check.message });

  const now = new Date().toISOString();
  const id = uid("cpo");
  db.prepare(`INSERT INTO china_purchase_orders
    (id, number, supplier_id, supplier_order_no, channel, order_date, plan_ship_date, plan_arrive_date,
     status, currency, rate, total_amount, track_no, link, comment, attachment, created_by, created_at, updated_at, is_archived)
    VALUES (?,?,?,?,?,?,?,?,'ordered',?,?,0,?,?,?,?,?,?,?,0)`)
    .run(id, nextPurchaseNumber(), b.supplierId, str(b.supplierOrderNo, 120), str(b.channel, 120),
         dateOrNull(b.orderDate), dateOrNull(b.planShipDate), dateOrNull(b.planArriveDate),
         str(b.currency, 10) || "CNY", b.rate == null || b.rate === "" ? null : num(b.rate),
         str(b.trackNo, 120), str(b.link, 500), str(b.comment, 1000), str(b.attachment, 400) || null,
         req.session.username, now, now);

  replaceItems(id, check.items);
  writeHistory(id, null, "ordered", req.session.username, "Закупка создана");
  logAudit({ user: req.session.username, action: "china_purchase_create", comment: `Закупка №${db.prepare("SELECT number FROM china_purchase_orders WHERE id = ?").get(id).number}` });

  const row = db.prepare("SELECT * FROM china_purchase_orders WHERE id = ?").get(id);
  res.json(rowToPurchase(row));
});

router.put("/:id", (req, res) => {
  const row = db.prepare("SELECT * FROM china_purchase_orders WHERE id = ?").get(req.params.id);
  if (!row) return res.status(404).json({ error: "not_found", message: "Закупка не найдена" });
  const b = req.body || {};
  const check = validatePayload(b);
  if (check.error) return res.status(400).json({ error: check.error, message: check.message });

  // Правим только те поля, которые реально прислали: иначе частичный запрос
  // молча стирал бы плановые даты, трек-номер и комментарий
  const map = {
    supplierId: ["supplier_id", v => v],
    supplierOrderNo: ["supplier_order_no", v => str(v, 120)],
    channel: ["channel", v => str(v, 120)],
    orderDate: ["order_date", dateOrNull],
    planShipDate: ["plan_ship_date", dateOrNull],
    planArriveDate: ["plan_arrive_date", dateOrNull],
    currency: ["currency", v => str(v, 10) || "CNY"],
    rate: ["rate", v => (v == null || v === "" ? null : num(v))],
    trackNo: ["track_no", v => str(v, 120)],
    link: ["link", v => str(v, 500)],
    comment: ["comment", v => str(v, 1000)],
    attachment: ["attachment", v => str(v, 400) || null]
  };
  const updates = [];
  const params = [];
  for (const [key, [col, conv]] of Object.entries(map)) {
    if (Object.prototype.hasOwnProperty.call(b, key)) {
      updates.push(`${col} = ?`);
      params.push(conv(b[key]));
    }
  }
  updates.push("updated_at = ?");
  params.push(new Date().toISOString(), row.id);
  db.prepare(`UPDATE china_purchase_orders SET ${updates.join(", ")} WHERE id = ?`).run(...params);

  replaceItems(row.id, check.items);
  logAudit({ user: req.session.username, action: "china_purchase_edit", comment: `Закупка №${row.number}` });
  res.json(rowToPurchase(db.prepare("SELECT * FROM china_purchase_orders WHERE id = ?").get(row.id)));
});

// Смена статуса. Даты отправки и получения проставляются здесь же, чтобы
// «дни в пути» и просрочка считались сами и не зависели от того, вспомнил ли
// человек заполнить дату руками.
router.post("/:id/status", (req, res) => {
  const row = db.prepare("SELECT * FROM china_purchase_orders WHERE id = ?").get(req.params.id);
  if (!row) return res.status(404).json({ error: "not_found", message: "Закупка не найдена" });
  const to = String(req.body?.status || "");
  if (!STATUSES.includes(to)) return res.status(400).json({ error: "bad_status", message: "Неизвестный статус" });

  const now = new Date().toISOString();
  const updates = ["status = ?", "updated_at = ?"];
  const params = [to, now];

  if (to === "transit") {
    const shipDate = dateOrNull(req.body?.factShipDate) || row.fact_ship_date || today();
    updates.push("fact_ship_date = ?");
    params.push(shipDate);
  }
  if (to === "received") {
    const recvDate = dateOrNull(req.body?.factReceiveDate) || row.fact_receive_date || today();
    updates.push("fact_receive_date = ?");
    params.push(recvDate);
    // Получение без отправки — значит отправку просто не отметили; ставим ту же
    // дату, иначе «дни в пути» посчитать не из чего
    if (!row.fact_ship_date) { updates.push("fact_ship_date = ?"); params.push(recvDate); }
  }
  params.push(row.id);
  db.prepare(`UPDATE china_purchase_orders SET ${updates.join(", ")} WHERE id = ?`).run(...params);

  // Количества: при отправке и получении можно проставить частично
  const qty = req.body?.quantities;
  if (qty && typeof qty === "object") {
    for (const [itemId, values] of Object.entries(qty)) {
      const item = db.prepare("SELECT * FROM china_purchase_order_items WHERE id = ? AND purchase_order_id = ?").get(itemId, row.id);
      if (!item) continue;
      const shipped = values.qtyShipped == null ? num(item.qty_shipped) : num(values.qtyShipped);
      const received = values.qtyReceived == null ? num(item.qty_received) : num(values.qtyReceived);
      db.prepare("UPDATE china_purchase_order_items SET qty_shipped = ?, qty_received = ? WHERE id = ?")
        .run(Math.max(0, shipped), Math.max(0, received), item.id);
    }
  } else if (to === "transit" || to === "received") {
    // Количества не прислали — считаем, что ушло/пришло всё заказанное
    const field = to === "transit" ? "qty_shipped" : "qty_received";
    db.prepare(`UPDATE china_purchase_order_items SET ${field} = qty_ordered WHERE purchase_order_id = ?`).run(row.id);
    if (to === "received") {
      db.prepare("UPDATE china_purchase_order_items SET qty_shipped = qty_ordered WHERE purchase_order_id = ? AND qty_shipped = 0").run(row.id);
    }
  }

  writeHistory(row.id, row.status, to, req.session.username, str(req.body?.comment, 500));
  logAudit({
    user: req.session.username, action: "china_purchase_status",
    oldValue: STATUS_LABELS[row.status], newValue: STATUS_LABELS[to],
    comment: `Закупка №${row.number}`
  });
  res.json(rowToPurchase(db.prepare("SELECT * FROM china_purchase_orders WHERE id = ?").get(row.id)));
});

// Архив вместо удаления: физически записи не трём, чтобы не терять историю
router.post("/:id/archive", (req, res) => {
  const row = db.prepare("SELECT * FROM china_purchase_orders WHERE id = ?").get(req.params.id);
  if (!row) return res.status(404).json({ error: "not_found" });
  const toArchive = req.body?.archived === false ? 0 : 1;
  db.prepare("UPDATE china_purchase_orders SET is_archived = ?, updated_at = ? WHERE id = ?")
    .run(toArchive, new Date().toISOString(), row.id);
  writeHistory(row.id, row.status, row.status, req.session.username, toArchive ? "Отправлено в архив" : "Возвращено из архива");
  res.json({ ok: true, isArchived: !!toArchive });
});

// Физическое удаление — только администратору (ТЗ 14)
router.delete("/:id", (req, res) => {
  if (req.session.role !== "admin") {
    return res.status(403).json({ error: "forbidden", message: "Удалять закупки может только администратор — остальным доступен архив" });
  }
  const row = db.prepare("SELECT * FROM china_purchase_orders WHERE id = ?").get(req.params.id);
  if (!row) return res.status(404).json({ error: "not_found" });
  db.prepare("DELETE FROM china_purchase_order_items WHERE purchase_order_id = ?").run(row.id);
  db.prepare("DELETE FROM china_purchase_history WHERE purchase_order_id = ?").run(row.id);
  db.prepare("DELETE FROM china_purchase_orders WHERE id = ?").run(row.id);
  logAudit({ user: req.session.username, action: "china_purchase_delete", comment: `Закупка №${row.number}` });
  res.json({ ok: true });
});

export default router;

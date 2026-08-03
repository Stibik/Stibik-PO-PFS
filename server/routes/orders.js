import express from "express";
import { db, nextReceiptNumber, logAudit, getKaspiShops, getMeta, setMeta } from "../db.js";
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
  const order = {
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
    manualPacking: !!row.manual_packing,
    assembled: !!row.assembled,
    courierTransmissionDate: row.courier_transmission_date,
    courierTransmissionPlanningDate: row.courier_transmission_planning_date,
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
    claimArchived: !!row.claim_archived,
    claimHidden: !!row.claim_hidden,
    raw: row.raw ? JSON.parse(row.raw) : null,
    entriesRaw: row.entries_raw ? JSON.parse(row.entries_raw) : null,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };

  // Статус/стадия заказа из Kaspi считается во фронтенде через classifyStage()
  // (там же учитывается срок упаковки, отмены, возвраты и т.д.) — здесь
  // достаточно отдать сырые kaspiStatus/deliveryState, что и происходит выше.

  return order;
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
     buy_price_cny, buy_price_kzt, delivery_price, sale_price, category, shop, status, created_at, updated_at)
    VALUES (?, 'manual', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'preorder', ?, ?)`)
    .run(id, receiptNumber, b.article || "", b.name || "", b.qty || 0, b.note || "", b.photo || null,
         b.receiveStatus || b.status || "new", b.orderDate || now.slice(0,10),
         b.buyPriceCny || 0, b.buyPriceKzt || 0, b.deliveryPrice || 0, b.salePrice || 0, b.category || "",
         b.shop || null, now, now);
  logAudit({ user: req.session.username, action: "create_order", orderId: id, newValue: b.name || b.article });
  const row = db.prepare("SELECT * FROM orders WHERE id = ?").get(id);
  res.json(rowToOrder(row));
});

// Заказ, созданный вручную (не из Kaspi) — например, оплата пришла напрямую,
// минуя Kaspi. Получает номер вида "УД-N" (свой отдельный счётчик, не путать
// с kaspi_code настоящих заказов) и, как и обычный заказ из Kaspi, сразу
// создаёт связанную запись в "Производстве" — чтобы дальше можно было списать
// материал и начислить зарплату исполнителю точно так же, как по заказам Kaspi.
router.post("/manual-order", (req, res) => {
  const b = req.body || {};
  if (!b.name) return res.status(400).json({ error: "name_required", message: "Укажите название товара" });

  const n = parseInt(getMeta("next_manual_order_number") || "1", 10);
  setMeta("next_manual_order_number", n + 1);
  const udCode = `УД-${n}`;
  const SHOP_TAG = "УД"; // фиксированно, не из формы — чтобы не путалось с реальными магазинами PFS/SA

  const id = uid();
  const now = new Date().toISOString();
  db.prepare(`INSERT INTO orders
    (id, source, kaspi_code, display_number, shop, status, product_name, article, qty, total_price, note, created_at, updated_at)
    VALUES (?, 'manual', ?, ?, ?, 'preorder', ?, ?, ?, ?, ?, ?, ?)`)
    .run(id, udCode, n, SHOP_TAG, b.name, b.article || "",
         b.qty || 1, b.totalPrice || 0, b.note || "", now, now);

  const prodId = uid();
  db.prepare(`INSERT INTO production (id, order_id, article, product_name, quantity, shop, stage, created_at)
              VALUES (?, ?, ?, ?, ?, ?, 'pending', ?)`)
    .run(prodId, id, b.article || "", b.name, b.qty || 1, SHOP_TAG, now);

  logAudit({ user: req.session.username, action: "create_manual_order", orderId: id, newValue: `${udCode}: ${b.name}` });

  const row = db.prepare("SELECT * FROM orders WHERE id = ?").get(id);
  res.json(rowToOrder(row));
});

// Редактирование ручного заказа (не Kaspi!) — только для source='manual',
// у настоящих заказов Kaspi это не имеет смысла, там источник правды — сам Kaspi
router.put("/:id/manual-order", (req, res) => {
  const row = db.prepare("SELECT * FROM orders WHERE id = ?").get(req.params.id);
  if (!row) return res.status(404).json({ error: "not_found" });
  if (row.source !== "manual") return res.status(400).json({ error: "not_manual", message: "Редактировать так можно только заказы, созданные вручную" });
  const b = req.body || {};
  const now = new Date().toISOString();
  db.prepare(`UPDATE orders SET product_name=?, article=?, qty=?, total_price=?, note=?, updated_at=? WHERE id=?`)
    .run(b.name ?? row.product_name, b.article ?? row.article, b.qty ?? row.qty,
         b.totalPrice ?? row.total_price, b.note ?? row.note, now, req.params.id);
  logAudit({ user: req.session.username, action: "edit_manual_order", orderId: req.params.id });
  const updated = db.prepare("SELECT * FROM orders WHERE id = ?").get(req.params.id);
  res.json(rowToOrder(updated));
});

// Удаление ручного заказа (не Kaspi!) — тоже только для source='manual'.
// Заодно убираем связанную запись в Производстве, чтобы не осталась "висеть" сиротой.
router.delete("/:id/manual-order", (req, res) => {
  const row = db.prepare("SELECT * FROM orders WHERE id = ?").get(req.params.id);
  if (!row) return res.status(404).json({ error: "not_found" });
  if (row.source !== "manual") return res.status(400).json({ error: "not_manual", message: "Удалить так можно только заказы, созданные вручную" });
  db.prepare("DELETE FROM production WHERE order_id = ?").run(req.params.id);
  db.prepare("DELETE FROM orders WHERE id = ?").run(req.params.id);
  logAudit({ user: req.session.username, action: "delete_manual_order", orderId: req.params.id, oldValue: row.kaspi_code });
  res.json({ ok: true });
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
    claimNote: "claim_note", claimResolved: "claim_resolved",
    claimArchived: "claim_archived", claimHidden: "claim_hidden", printed: "printed",
    shop: "shop"
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

// Быстрое действие прямо из списка, без открытия карточки — только для самого
// частого шага (этикетка готова → готов к отгрузке). Если грузовое место ещё
// не сформировано — создаёт его автоматически (одно, с дефолтным номером),
// вместо того чтобы заставлять сначала зайти внутрь и нажать "+Добавить место".
// Модалка нужна только для отмены/деталей/исправления — это ускоряет обычный,
// повторяющийся путь.
router.post("/:id/quick-advance", (req, res) => {
  const row = db.prepare("SELECT * FROM orders WHERE id = ?").get(req.params.id);
  if (!row) return res.status(404).json({ error: "not_found" });
  if (row.status !== "label_printed") {
    return res.status(400).json({ error: "wrong_status", message: "Быстрое действие доступно только на шаге «Этикетка готова»" });
  }

  const now = new Date().toISOString();
  const places = db.prepare("SELECT * FROM cargo_places WHERE order_id = ?").all(row.id);
  const hasFormed = places.some(p => p.formed);
  if (!hasFormed) {
    const placeNumber = places.length + 1;
    db.prepare(`INSERT INTO cargo_places (id, order_id, place_number, name, formed, formed_at, formed_by)
                VALUES (?, ?, ?, ?, 1, ?, ?)`)
      .run(uid(), row.id, placeNumber, null, now, req.session.username);
  }

  db.prepare("UPDATE orders SET status='ready', updated_at=? WHERE id=?").run(now, row.id);
  db.prepare(`INSERT INTO status_history (order_id, from_status, to_status, user, reason, is_correction, created_at)
              VALUES (?, ?, 'ready', ?, 'Быстрое действие из списка', 0, ?)`)
    .run(row.id, row.status, req.session.username, now);
  logAudit({ user: req.session.username, action: "quick_advance", orderId: row.id, oldValue: row.status, newValue: "ready" });

  const updatedRow = db.prepare("SELECT * FROM orders WHERE id = ?").get(row.id);
  res.json(rowToOrder(updatedRow));
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

// ---------- Двусторонняя синхронизация: толкаем статус обратно в Kaspi ----------
// По документации Kaspi ("сформировать накладную для передачи заказа на Kaspi
// Доставку") — единственный найденный способ реально продвинуть заказ дальше
// стадии "Упаковка" со своей стороны. numberOfSpace = сколько грузовых мест
// сформировано у нас — ровно то же число, что и в "Грузовые места" ниже.
// НЕ ПРОВЕРЕНО на реальном токене (в песочнице разработки нет сети до
// kaspi.kz) — первый реальный вызов стоит сделать на некритичном заказе.
// Ручной перенос предзаказа в нашу внутреннюю "Упаковку" — не трогает Kaspi
// вообще, только наш собственный флаг классификации. Позволяет начать
// работу над заказом (места, печать), пока Kaspi ещё официально считает
// его предзаказом.
router.post("/:id/move-to-packing", (req, res) => {
  const row = db.prepare("SELECT * FROM orders WHERE id = ?").get(req.params.id);
  if (!row) return res.status(404).json({ error: "not_found" });
  db.prepare("UPDATE orders SET manual_packing = 1 WHERE id = ?").run(req.params.id);
  logAudit({ user: req.session.username, action: "manual_move_to_packing", orderId: req.params.id });
  res.json({ ok: true });
});

// Подтверждение готовности ПРЕДЗАКАЗА (не путать с kaspi-assemble ниже!).
// По официальной инструкции Kaspi "Как обработать предзаказ": кнопка "Прибыл"
// в кабинете продавца → статус ARRIVED. Независимый источник (интеграция
// МойСклад-Kaspi) прямо подтверждает: ASSEMBLE для предзаказов НЕ работает —
// это ограничение самого API Kaspi. Значит для снятия пометки "предзаказ"
// нужен именно этот метод, а не ASSEMBLE.
router.post("/:id/kaspi-preorder-arrived", async (req, res) => {
  const row = db.prepare("SELECT * FROM orders WHERE id = ?").get(req.params.id);
  if (!row) return res.status(404).json({ error: "not_found" });
  if (row.source !== "kaspi" || !row.kaspi_order_id) {
    return res.status(400).json({ error: "not_kaspi_order", message: "Это не заказ из Kaspi" });
  }
  if (!row.pre_order) {
    return res.status(400).json({ error: "not_preorder", message: "Этот заказ и так не помечен как предзаказ" });
  }

  const shops = getKaspiShops();
  const shopConfig = shops.find(s => s.name === row.shop);
  if (!shopConfig || !shopConfig.token) {
    return res.status(400).json({ error: "no_token", message: `Не найден токен Kaspi для магазина «${row.shop}»` });
  }

  const requestBody = {
    data: {
      type: "orders",
      id: row.kaspi_order_id,
      attributes: { code: row.kaspi_code, status: "ARRIVED" }
    }
  };
  console.log(`[kaspi-preorder-arrived] Заказ ${row.id} (${row.kaspi_code}, ${row.shop}) — отправляю:`, JSON.stringify(requestBody));

  try {
    const resp = await fetch("https://kaspi.kz/shop/api/v2/orders", {
      method: "POST",
      headers: { "Content-Type": "application/vnd.api+json", "X-Auth-Token": shopConfig.token },
      body: JSON.stringify(requestBody),
      signal: AbortSignal.timeout(15000)
    });
    const text = await resp.text();
    console.log(`[kaspi-preorder-arrived] Ответ Kaspi: статус ${resp.status}, тело:`, text.slice(0, 1000));
    if (!resp.ok) {
      return res.status(502).json({ error: "kaspi_error", message: `Kaspi ответил ${resp.status}: ${text.slice(0, 300)}` });
    }
    let kaspiJson = null;
    try { kaspiJson = JSON.parse(text); } catch (e) {}

    db.prepare("UPDATE orders SET pre_order = 0, updated_at = ? WHERE id = ?").run(new Date().toISOString(), row.id);
    logAudit({ user: req.session.username, action: "kaspi_preorder_arrived", orderId: row.id });

    res.json({ ok: true, kaspiResponse: kaspiJson });
  } catch (e) {
    console.error(`[kaspi-preorder-arrived] Исключение для заказа ${row.id}:`, e.message);
    res.status(500).json({ error: "request_failed", message: e.message });
  }
});

router.post("/:id/kaspi-assemble", async (req, res) => {
  const row = db.prepare("SELECT * FROM orders WHERE id = ?").get(req.params.id);
  if (!row) return res.status(404).json({ error: "not_found" });
  if (row.source !== "kaspi" || !row.kaspi_order_id) {
    return res.status(400).json({ error: "not_kaspi_order", message: "Это не заказ из Kaspi — передавать некуда" });
  }

  const shops = getKaspiShops();
  const shopConfig = shops.find(s => s.name === row.shop);
  if (!shopConfig || !shopConfig.token) {
    return res.status(400).json({ error: "no_token", message: `Не найден токен Kaspi для магазина «${row.shop}»` });
  }

  // Сначала сверяем реальное ТЕКУЩЕЕ состояние у Kaspi — у нас в базе может
  // быть устаревшая картина (заказ уже мог уйти дальше стадии сборки между
  // синхронизациями). Если Kaspi уже считает его собранным/переданным дальше —
  // просто обновляем свои данные, вместо того чтобы слать ASSEMBLE и получать
  // отказ "текущий статус не позволяет это действие".
  try {
    const checkResp = await fetch(
      `https://kaspi.kz/shop/api/v2/orders?filter[orders][code]=${encodeURIComponent(row.kaspi_code)}`,
      { headers: { "Content-Type": "application/vnd.api+json", "X-Auth-Token": shopConfig.token }, signal: AbortSignal.timeout(15000) }
    );
    if (checkResp.ok) {
      const checkJson = await checkResp.json();
      const freshAttrs = checkJson?.data?.[0]?.attributes;
      if (freshAttrs && freshAttrs.assembled) {
        const now2 = new Date().toISOString();
        db.prepare("UPDATE orders SET assembled=1, kaspi_status=?, delivery_state=?, updated_at=? WHERE id=?")
          .run(freshAttrs.status, freshAttrs.state, now2, row.id);
        return res.json({
          ok: true, alreadyAssembled: true,
          message: "У Kaspi этот заказ уже собран/передан дальше — наши данные были устаревшими, сейчас обновил их, отправлять ASSEMBLE не нужно"
        });
      }
    }
  } catch (e) {
    console.error(`[kaspi-assemble] Не удалось сверить текущий статус перед отправкой (${row.kaspi_code}):`, e.message);
    // не блокируем основной запрос из-за ошибки самой сверки — пробуем всё равно
  }

  const formedPlaces = db.prepare("SELECT COUNT(*) as c FROM cargo_places WHERE order_id = ? AND formed = 1").get(req.params.id).c;
  const numberOfSpace = formedPlaces > 0 ? formedPlaces : 1;
  const requestBody = {
    data: {
      type: "orders",
      id: row.kaspi_order_id,
      attributes: { status: "ASSEMBLE", numberOfSpace: String(numberOfSpace) }
    }
  };
  console.log(`[kaspi-assemble] Заказ ${row.id} (kaspi_order_id=${row.kaspi_order_id}, магазин=${row.shop}) — отправляю запрос:`, JSON.stringify(requestBody));

  try {
    const resp = await fetch("https://kaspi.kz/shop/api/v2/orders", {
      method: "POST",
      headers: { "Content-Type": "application/vnd.api+json", "X-Auth-Token": shopConfig.token },
      body: JSON.stringify(requestBody),
      signal: AbortSignal.timeout(15000) // не ждём Kaspi дольше 15 сек — иначе получим невнятный 502 от самого Render раньше, чем свой ответ
    });
    const text = await resp.text();
    console.log(`[kaspi-assemble] Ответ Kaspi: статус ${resp.status}, тело:`, text.slice(0, 1000));
    if (!resp.ok) {
      // "current order status does not allow this action" — это ожидаемый
      // отказ для предзаказов, которые Kaspi ещё не готов собирать. Заказ
      // остаётся в нашей "Упаковке" (manual_packing не трогаем), просто
      // сообщаем понятно, а не пугаем обычной ошибкой.
      if (/does not allow this action/i.test(text)) {
        return res.json({
          ok: true, kaspiPending: true,
          message: "Заказ упакован, но Kaspi пока не разрешил сформировать накладную. Повторите позже"
        });
      }
      return res.status(502).json({ error: "kaspi_error", message: `Kaspi ответил ${resp.status}: ${text.slice(0, 300)}` });
    }
    let kaspiJson = null;
    try { kaspiJson = JSON.parse(text); } catch (e) { /* не критично, вернём как есть */ }

    const now = new Date().toISOString();
    // Реальный мир (Kaspi подтвердил "собран") важнее нашего внутреннего
    // чек-листа — если внутренний статус ещё не дошёл до "ready", подтягиваем
    // его вперёд. Назад никогда не двигаем (мало ли что уже отмечено).
    const STATUS_ORDER = ["preorder", "packing", "label_printed", "ready", "shipped"];
    const currentIdx = STATUS_ORDER.indexOf(row.status);
    const readyIdx = STATUS_ORDER.indexOf("ready");
    let newInternalStatus = row.status;
    if (currentIdx >= 0 && currentIdx < readyIdx) {
      newInternalStatus = "ready";
      db.prepare("UPDATE orders SET status = ? WHERE id = ?").run(newInternalStatus, req.params.id);
      db.prepare(`INSERT INTO status_history (order_id, from_status, to_status, user, reason, created_at)
                  VALUES (?, ?, 'ready', ?, 'Автоматически после передачи в Kaspi', ?)`)
        .run(req.params.id, row.status, req.session.username, now);
    }

    db.prepare("UPDATE orders SET assembled = 1, updated_at = ? WHERE id = ?").run(now, req.params.id);
    logAudit({ user: req.session.username, action: "kaspi_assemble", orderId: req.params.id, comment: `numberOfSpace=${numberOfSpace}` });

    res.json({ ok: true, numberOfSpace, kaspiResponse: kaspiJson, internalStatus: newInternalStatus });
  } catch (e) {
    console.error(`[kaspi-assemble] Исключение для заказа ${row.id}:`, e.message, e.stack);
    res.status(500).json({ error: "request_failed", message: e.message });
  }
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

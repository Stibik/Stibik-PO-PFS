import express from "express";
import { db, getKaspiShops, nextOrderNumber, nextStockNumber, logAudit } from "../db.js";
import { requireAuth } from "../middleware/auth.js";
import { syncShop } from "../kaspi.js";

const router = express.Router();
router.use(requireAuth);

function getConfiguredShops() {
  const dbShops = getKaspiShops();
  const shops = [];
  for (let i = 0; i < 3; i++) {
    const dbShop = dbShops[i] || {};
    const token = dbShop.token || process.env[`KASPI_TOKEN_SHOP${i + 1}`];
    const name = dbShop.name || process.env[`KASPI_SHOP${i + 1}_NAME`] || `Магазин ${i + 1}`;
    if (token) shops.push({ token, name, syncFromDate: dbShop.syncFromDate || "" });
  }
  return shops;
}

// Достаём артикул (SKU) товара из сырых данных о позициях заказа — та же
// структура entriesRaw.data[0].attributes.offer.code, что разбирали раньше.
// Берём только первую позицию — для заказов с несколькими товарами это
// упрощение, производство пока привязывается к первому товару в заказе.
function extractArticle(entriesRaw) {
  try {
    return entriesRaw?.data?.[0]?.attributes?.offer?.code || null;
  } catch (e) { return null; }
}
function extractOfferName(entriesRaw) {
  try {
    return entriesRaw?.data?.[0]?.attributes?.offer?.name || null;
  } catch (e) { return null; }
}
function extractQuantity(entriesRaw) {
  try {
    return entriesRaw?.data?.[0]?.attributes?.quantity || 1;
  } catch (e) { return 1; }
}
// Настоящая дата создания заказа В KASPI (не путать с нашим created_at —
// когда мы впервые увидели заказ у себя в базе, это разные даты!)
function extractKaspiCreationDate(raw) {
  try {
    return raw?.creationDate ? new Date(raw.creationDate).toISOString() : null;
  } catch (e) { return null; }
}
function genId(prefix) {
  return prefix + "_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

// Обычная синхронизация (syncShop) ищет заказы по диапазону дат СОЗДАНИЯ,
// максимум 14 дней — это ограничение самого Kaspi API. Заказ, который старше
// 14 дней, но всё ещё активен (не завершён/не отменён/не архив), просто
// перестаёт попадать в эту выборку — и его статус у нас "замерзает" навсегда,
// даже если в Kaspi он давно изменился.
//
// Чиним точечно: у Kaspi есть отдельный метод получить ОДИН заказ по коду,
// без ограничения по дате — https://kaspi.kz/shop/api/v2/orders?filter[orders][code]=...
// Раз в синхронизацию проверяем таким способом небольшую пачку самых старых
// зависших активных заказов (не все разом — чтобы не перегружать Kaspi API).
async function refreshStaleOrders(token, shopName, limit = 50) {
  const staleOrders = db.prepare(`
    SELECT * FROM orders
    WHERE shop = ? AND source = 'kaspi'
      AND kaspi_status NOT IN ('CANCELLED', 'COMPLETED', 'RETURNED')
      AND delivery_state != 'ARCHIVE'
      AND kaspi_creation_date IS NOT NULL
      AND datetime(kaspi_creation_date) < datetime('now', '-13 days')
    ORDER BY kaspi_creation_date ASC
    LIMIT ?
  `).all(shopName, limit);

  let refreshed = 0, changed = 0, errors = 0;
  const now = new Date().toISOString();

  for (const existing of staleOrders) {
    try {
      const resp = await fetch(
        `https://kaspi.kz/shop/api/v2/orders?filter[orders][code]=${encodeURIComponent(existing.kaspi_code)}`,
        { headers: { "Content-Type": "application/vnd.api+json", "X-Auth-Token": token } }
      );
      if (!resp.ok) {
        console.error(`[kaspi/stale] Kaspi API вернул ${resp.status} для заказа ${existing.kaspi_code} (${shopName})`);
        errors++; continue;
      }
      const json = await resp.json();
      const attrs = json?.data?.[0]?.attributes;
      if (!attrs) {
        console.error(`[kaspi/stale] Пустой ответ для заказа ${existing.kaspi_code} (${shopName})`);
        errors++; continue;
      }

      const newStatus = attrs.status;
      const newState = attrs.state;
      const newAssembled = !!attrs.assembled;
      const newPreOrder = !!attrs.preOrder;
      const newPlanningDate = attrs.kaspiDelivery?.courierTransmissionPlanningDate
        ? new Date(attrs.kaspiDelivery.courierTransmissionPlanningDate).toISOString() : null;
      const statusChanged = existing.kaspi_status !== newStatus || existing.delivery_state !== newState;

      db.prepare(`UPDATE orders SET kaspi_status=?, delivery_state=?, assembled=?, pre_order=?, courier_transmission_planning_date=?, updated_at=? WHERE id=?`)
        .run(newStatus, newState, newAssembled ? 1 : 0, newPreOrder ? 1 : 0, newPlanningDate, statusChanged ? now : existing.updated_at, existing.id);

      // Тот же хук пополнения виртуального склада, что и в обычной синхронизации
      if (statusChanged && (newStatus === "CANCELLED" || newStatus === "RETURNED") && newAssembled) {
        let entriesRaw = null;
        try { entriesRaw = existing.entries_raw ? JSON.parse(existing.entries_raw) : null; } catch (e) {}
        const article = extractArticle(entriesRaw);
        // Название обязательно: без него на складе появлялась безымянная строка
        // «—», и восемь разных изделий слипались в одну кучу, которую нельзя
        // ни опознать, ни выдать в заказ. Берём лучшее из доступного.
        const whName = existing.product_name || extractOfferName(entriesRaw)
          || (article ? `Артикул ${article}` : `Возврат по заказу №${existing.display_number || existing.kaspi_code}`);
        db.prepare(`INSERT INTO warehouse_stock
          (id, stock_number, article, product_name, source, source_order_id, qty, consumed, created_at)
          VALUES (?, ?, ?, ?, ?, ?, 1, 0, ?)`)
          .run(genId("wh"), nextStockNumber(), article, whName,
               newStatus === "CANCELLED" ? "cancelled" : "returned", existing.id, now);
      }

      refreshed++;
      if (statusChanged) changed++;
    } catch (e) {
      console.error(`[kaspi/stale] Ошибка обновления заказа ${existing.kaspi_code} (${shopName}):`, e.message);
      errors++;
    }
  }
  return { checked: staleOrders.length, refreshed, changed, errors };
}

router.get("/shops", (req, res) => {
  res.json(getConfiguredShops().map(s => s.name));
});

router.post("/sync", async (req, res) => {
 try {
  const shops = getConfiguredShops();
  const includeArchive = !!(req.body && req.body.includeArchive);
  if (!shops.length) {
    return res.status(400).json({ error: "no_shops_configured", message: "Токены Kaspi не настроены — добавьте их в разделе «Заказы» → «Настройки Kaspi»" });
  }
  const results = [];
  for (const shop of shops) {
    let syncOk = false;
    try {
      let daysBack = 14;
      if (shop.syncFromDate) {
        const fromMs = new Date(shop.syncFromDate + "T00:00:00").getTime();
        if (!isNaN(fromMs)) {
          const diffDays = Math.ceil((Date.now() - fromMs) / 86400000);
          if (diffDays > 0) daysBack = Math.min(diffDays, 14); // API не даёт больше 14 дней за раз
        }
      }
      const kaspiOrders = await syncShop(shop.token, shop.name, { daysBack });
      let added = 0, updated = 0, skippedArchive = 0;
      const now = new Date().toISOString();

      for (const ko of kaspiOrders) {
        // Берём ВЕСЬ существующий ряд (не только id) — нужен его текущий
        // kaspi_status/delivery_state/updated_at для сравнения ниже.
        const existing = db.prepare("SELECT * FROM orders WHERE kaspi_order_id = ?").get(ko.kaspiOrderId);
        if (existing) {
          // Kaspi не присылает дату отмены/смены статуса напрямую (подтверждено
          // документацией API) — приближаем её как "когда статус/состояние
          // заказа у нас в базе последний раз реально поменялись".
          // ВАЖНО: раньше updated_at обновлялся на КАЖДУЮ синхронизацию, даже
          // если ничего не изменилось — с автосинхронизацией каждые 3 минуты
          // это делало дату всегда "сегодня" и ломало расчёт "дней с отмены".
          // Теперь трогаем updated_at только если статус или состояние реально другие.
          const statusChanged = existing.kaspi_status !== ko.status || existing.delivery_state !== ko.deliveryState;
          const updatedAtValue = statusChanged ? now : existing.updated_at;
          const kaspiCreationDate = extractKaspiCreationDate(ko.raw) || existing.kaspi_creation_date;
          db.prepare(`UPDATE orders SET
            kaspi_code=?, shop=?, kaspi_status=?, delivery_state=?, pre_order=?, assembled=?,
            courier_transmission_date=?, courier_transmission_planning_date=?, courier_handover_date=?, total_price=?, product_name=?,
            product_photo=?, waybill_url=?, raw=?, entries_raw=?, kaspi_creation_date=?, updated_at=? WHERE id=?`)
            .run(ko.kaspiCode, ko.shop, ko.status, ko.deliveryState, ko.preOrder ? 1 : 0, ko.assembled ? 1 : 0,
                 ko.courierTransmissionDate, ko.courierTransmissionPlanningDate, ko.courierHandoverDate, ko.totalPrice, ko.productName,
                 ko.productPhoto || null, ko.waybillUrl, JSON.stringify(ko.raw || {}),
                 JSON.stringify(ko.entriesRaw || {}), kaspiCreationDate, updatedAtValue, existing.id);
          updated++;

          // Пополнение виртуального склада: если заказ только что стал отменён
          // или возвращён, а товар уже был собран (assembled=true) — значит
          // физически готовое изделие освободилось и его можно отдать под
          // следующий такой же заказ вместо нового производства.
          const justCancelledOrReturned = statusChanged && (ko.status === "CANCELLED" || ko.status === "RETURNED");
          if (justCancelledOrReturned && ko.assembled) {
            const article = extractArticle(ko.entriesRaw);
            const whName = ko.productName || extractOfferName(ko.entriesRaw)
              || (article ? `Артикул ${article}` : `Возврат по заказу ${ko.kaspiCode}`);
            db.prepare(`INSERT INTO warehouse_stock
              (id, stock_number, article, product_name, source, source_order_id, qty, consumed, created_at)
              VALUES (?, ?, ?, ?, ?, ?, 1, 0, ?)`)
              .run(genId("wh"), nextStockNumber(), article, whName,
                   ko.status === "CANCELLED" ? "cancelled" : "returned", existing.id, now);
          }
        } else {
          if (ko.deliveryState === "ARCHIVE" && !includeArchive) { skippedArchive++; continue; }
          // Сквозной номер на всю программу: SA и PFS идут одним рядом,
          // как в старой таблице. Отдельные счётчики по магазинам давали
          // разные номера у соседних заказов и не бились с прежним учётом.
          const displayNumber = nextOrderNumber();
          const id = "kord_" + ko.kaspiOrderId;
          db.prepare(`INSERT INTO orders
            (id, source, kaspi_order_id, kaspi_code, shop, display_number, status, kaspi_status,
             delivery_state, pre_order, assembled, courier_transmission_date, courier_transmission_planning_date, courier_handover_date,
             total_price, product_name, product_photo, waybill_url, raw, entries_raw, kaspi_creation_date, created_at, updated_at)
            VALUES (?, 'kaspi', ?, ?, ?, ?, 'preorder', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
            .run(id, ko.kaspiOrderId, ko.kaspiCode, ko.shop, displayNumber, ko.status, ko.deliveryState,
                 ko.preOrder ? 1 : 0, ko.assembled ? 1 : 0, ko.courierTransmissionDate, ko.courierTransmissionPlanningDate, ko.courierHandoverDate,
                 ko.totalPrice, ko.productName, ko.productPhoto || null, ko.waybillUrl,
                 JSON.stringify(ko.raw || {}), JSON.stringify(ko.entriesRaw || {}), extractKaspiCreationDate(ko.raw), now, now);
          added++;

          // Каждый новый заказ автоматически создаёт запись в "Производстве" —
          // ждёт решения (списать с остатков / присвоить исполнителя / перекрыть
          // возвратом), пока decision не заполнен (NULL).
          const article = extractArticle(ko.entriesRaw);
          db.prepare(`INSERT INTO production (id, order_id, article, product_name, quantity, shop, stage, created_at)
                      VALUES (?, ?, ?, ?, ?, ?, 'pending', ?)`)
            .run(genId("prod"), id, article, ko.productName || extractOfferName(ko.entriesRaw),
                 extractQuantity(ko.entriesRaw), ko.shop, now);
        }
      }
      results.push({ shop: shop.name, ok: true, added, updated, skippedArchive, total: kaspiOrders.length });
      syncOk = true;
      logAudit({ user: req.session.username, action: "kaspi_sync", comment: `${shop.name}: +${added} ~${updated}` });
    } catch (err) {
      results.push({ shop: shop.name, ok: false, error: err.message });
      logAudit({ user: req.session.username, action: "kaspi_sync_error", comment: `${shop.name}: ${err.message}` });
    }

    // Обновление "зависших" заказов — НЕЗАВИСИМО от того, упала ли основная
    // синхронизация выше. Раньше это было внутри того же try — если syncShop()
    // падал с ошибкой (нет сети, протухший токен), до сюда просто не доходило.
    try {
      const stale = await refreshStaleOrders(shop.token, shop.name);
      const target = results.find(r => r.shop === shop.name) || {};
      target.staleChecked = stale.checked;
      target.staleChanged = stale.changed;
      target.staleErrors = stale.errors;
      if (!results.includes(target)) results.push(target);
    } catch (staleErr) {
      console.error(`[kaspi/sync] Ошибка обновления зависших заказов (${shop.name}):`, staleErr.message);
    }
  }
  res.json({ results });
 } catch (fatalErr) {
  console.error("[kaspi/sync] Неожиданная ошибка:", fatalErr.message, fatalErr.stack);
  res.status(500).json({ error: "internal_error", message: fatalErr.message });
 }
});

export default router;

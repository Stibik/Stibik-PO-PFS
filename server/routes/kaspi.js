import express from "express";
import { db, getKaspiShops, nextKaspiNumber, logAudit } from "../db.js";
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
function genId(prefix) {
  return prefix + "_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
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
          db.prepare(`UPDATE orders SET
            kaspi_code=?, shop=?, kaspi_status=?, delivery_state=?, pre_order=?, assembled=?,
            courier_transmission_date=?, courier_handover_date=?, total_price=?, product_name=?,
            product_photo=?, waybill_url=?, raw=?, entries_raw=?, updated_at=? WHERE id=?`)
            .run(ko.kaspiCode, ko.shop, ko.status, ko.deliveryState, ko.preOrder ? 1 : 0, ko.assembled ? 1 : 0,
                 ko.courierTransmissionDate, ko.courierHandoverDate, ko.totalPrice, ko.productName,
                 ko.productPhoto || null, ko.waybillUrl, JSON.stringify(ko.raw || {}),
                 JSON.stringify(ko.entriesRaw || {}), updatedAtValue, existing.id);
          updated++;

          // Пополнение виртуального склада: если заказ только что стал отменён
          // или возвращён, а товар уже был собран (assembled=true) — значит
          // физически готовое изделие освободилось и его можно отдать под
          // следующий такой же заказ вместо нового производства.
          const justCancelledOrReturned = statusChanged && (ko.status === "CANCELLED" || ko.status === "RETURNED");
          if (justCancelledOrReturned && ko.assembled) {
            const article = extractArticle(ko.entriesRaw);
            db.prepare(`INSERT INTO warehouse_stock
              (id, article, product_name, source, source_order_id, qty, consumed, created_at)
              VALUES (?, ?, ?, ?, ?, 1, 0, ?)`)
              .run(genId("wh"), article, ko.productName || extractOfferName(ko.entriesRaw),
                   ko.status === "CANCELLED" ? "cancelled" : "returned", existing.id, now);
          }
        } else {
          if (ko.deliveryState === "ARCHIVE" && !includeArchive) { skippedArchive++; continue; }
          const displayNumber = nextKaspiNumber(shop.name);
          const id = "kord_" + ko.kaspiOrderId;
          db.prepare(`INSERT INTO orders
            (id, source, kaspi_order_id, kaspi_code, shop, display_number, status, kaspi_status,
             delivery_state, pre_order, assembled, courier_transmission_date, courier_handover_date,
             total_price, product_name, product_photo, waybill_url, raw, entries_raw, created_at, updated_at)
            VALUES (?, 'kaspi', ?, ?, ?, ?, 'preorder', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
            .run(id, ko.kaspiOrderId, ko.kaspiCode, ko.shop, displayNumber, ko.status, ko.deliveryState,
                 ko.preOrder ? 1 : 0, ko.assembled ? 1 : 0, ko.courierTransmissionDate, ko.courierHandoverDate,
                 ko.totalPrice, ko.productName, ko.productPhoto || null, ko.waybillUrl,
                 JSON.stringify(ko.raw || {}), JSON.stringify(ko.entriesRaw || {}), now, now);
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
      logAudit({ user: req.session.username, action: "kaspi_sync", comment: `${shop.name}: +${added} ~${updated}` });
    } catch (err) {
      results.push({ shop: shop.name, ok: false, error: err.message });
      logAudit({ user: req.session.username, action: "kaspi_sync_error", comment: `${shop.name}: ${err.message}` });
    }
  }
  res.json({ results });
 } catch (fatalErr) {
  console.error("[kaspi/sync] Неожиданная ошибка:", fatalErr.message, fatalErr.stack);
  res.status(500).json({ error: "internal_error", message: fatalErr.message });
 }
});

export default router;

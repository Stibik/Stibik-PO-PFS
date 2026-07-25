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
        } else {
          if (ko.deliveryState === "ARCHIVE" && !includeArchive) { skippedArchive++; continue; }
          const displayNumber = nextKaspiNumber();
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

import express from "express";
import { db } from "../db.js";
import { requireAuth } from "../middleware/auth.js";
import { syncShop } from "../kaspi.js";

const router = express.Router();
router.use(requireAuth);

function getConfiguredShops() {
  const shops = [];
  const dbShops = db.data.settings?.kaspi?.shops || [];
  for (let i = 0; i < 3; i++) {
    const dbShop = dbShops[i] || {};
    const token = dbShop.token || process.env[`KASPI_TOKEN_SHOP${i + 1}`];
    const name = dbShop.name || process.env[`KASPI_SHOP${i + 1}_NAME`] || `Магазин ${i + 1}`;
    if (token) shops.push({ token, name });
  }
  return shops;
}

router.get("/shops", async (req, res) => {
  await db.read();
  res.json(getConfiguredShops().map(s => s.name));
});

router.post("/sync", async (req, res) => {
  await db.read();
  const shops = getConfiguredShops();
  if (!shops.length) {
    return res.status(400).json({ error: "no_shops_configured", message: "Токены Kaspi не настроены — добавьте их в разделе «Заказы» → «Настройки Kaspi»" });
  }
  const results = [];
  for (const shop of shops) {
    try {
      const kaspiOrders = await syncShop(shop.token, shop.name);
      let added = 0, updated = 0;
      kaspiOrders.forEach(ko => {
        const existing = db.data.orders.find(o => o.kaspiOrderId === ko.kaspiOrderId);
        if (existing) {
          Object.assign(existing, ko);
          updated++;
        } else {
          const displayNumber = db.data.meta.nextKaspiNumber++;
          db.data.orders.push({ ...ko, id: "kord_" + ko.kaspiOrderId, source: "kaspi", displayNumber });
          added++;
        }
      });
      results.push({ shop: shop.name, ok: true, added, updated, total: kaspiOrders.length });
    } catch (err) {
      results.push({ shop: shop.name, ok: false, error: err.message });
    }
  }
  await db.write();
  res.json({ results });
});

export default router;

import express from "express";
import { getMeta, setMeta, getKaspiShops } from "../db.js";
import { requireAuth } from "../middleware/auth.js";

const router = express.Router();
router.use(requireAuth);

// Внутренняя нумерация заказов — отдельный счётчик на каждый магазин (SA/PFS
// не путаются между собой). Позволяет продолжить счёт с того места, где вы
// остановились в PRODIX/на бумаге, отдельно для каждого магазина.
router.get("/order-numbering", (req, res) => {
  const shops = getKaspiShops().filter(s => s.name && s.name.trim());
  const result = shops.map(s => ({
    shop: s.name,
    nextNumber: parseInt(getMeta(`next_kaspi_number:${s.name}`) || "1", 10)
  }));
  res.json({ shops: result });
});

router.post("/order-numbering", (req, res) => {
  const { shop, nextNumber } = req.body || {};
  if (!shop || !String(shop).trim()) {
    return res.status(400).json({ error: "shop_required", message: "Не указан магазин" });
  }
  const n = parseInt(nextNumber, 10);
  if (!Number.isFinite(n) || n < 1) {
    return res.status(400).json({ error: "invalid_number", message: "Укажите целое число, 1 или больше" });
  }
  setMeta(`next_kaspi_number:${shop}`, n);
  res.json({ ok: true, shop, nextNumber: n });
});

export default router;

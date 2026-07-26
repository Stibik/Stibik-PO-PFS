import express from "express";
import { getMeta, setMeta } from "../db.js";
import { requireAuth } from "../middleware/auth.js";

const router = express.Router();
router.use(requireAuth);

// Внутренняя нумерация заказов (то самое короткое "№", которое видит швея —
// не длинный код Kaspi). Позволяет продолжить счёт с того места, где вы
// остановились в PRODIX/на бумаге, вместо того чтобы начинать с 1.
router.get("/order-numbering", (req, res) => {
  const current = parseInt(getMeta("next_kaspi_number") || "1", 10);
  res.json({ nextNumber: current });
});

router.post("/order-numbering", (req, res) => {
  const { nextNumber } = req.body || {};
  const n = parseInt(nextNumber, 10);
  if (!Number.isFinite(n) || n < 1) {
    return res.status(400).json({ error: "invalid_number", message: "Укажите целое число, 1 или больше" });
  }
  setMeta("next_kaspi_number", n);
  res.json({ ok: true, nextNumber: n });
});

export default router;

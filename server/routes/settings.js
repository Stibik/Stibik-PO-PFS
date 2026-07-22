import express from "express";
import { db } from "../db.js";
import { requireAuth } from "../middleware/auth.js";

const router = express.Router();
router.use(requireAuth);

// Отдаём настройки Kaspi. Токены маскируем (показываем только конец),
// чтобы не светить их лишний раз на экране — но не как настоящее шифрование.
router.get("/kaspi", async (req, res) => {
  await db.read();
  const shops = db.data.settings.kaspi.shops.map(s => ({
    name: s.name,
    hasToken: !!s.token,
    tokenMasked: s.token ? "••••" + s.token.slice(-4) : ""
  }));
  res.json({ shops });
});

// Обновляем токен/имя одного магазина (index 0,1,2)
router.post("/kaspi/:index", async (req, res) => {
  const idx = parseInt(req.params.index, 10);
  if (isNaN(idx) || idx < 0 || idx > 2) return res.status(400).json({ error: "bad_index" });
  const { name, token } = req.body || {};
  await db.read();
  if (typeof name === "string" && name.trim()) db.data.settings.kaspi.shops[idx].name = name.trim();
  if (typeof token === "string" && token.trim()) db.data.settings.kaspi.shops[idx].token = token.trim();
  await db.write();
  res.json({ ok: true });
});

export default router;

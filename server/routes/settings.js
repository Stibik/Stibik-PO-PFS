import express from "express";
import { getKaspiShops, setKaspiShops } from "../db.js";
import { requireAuth } from "../middleware/auth.js";

const router = express.Router();
router.use(requireAuth);

router.get("/kaspi", (req, res) => {
  const shops = getKaspiShops().map(s => ({
    name: s.name,
    hasToken: !!s.token,
    tokenMasked: s.token ? "••••" + s.token.slice(-4) : "",
    syncFromDate: s.syncFromDate || ""
  }));
  res.json({ shops });
});

router.post("/kaspi/:index", (req, res) => {
  try {
    const idx = parseInt(req.params.index, 10);
    if (isNaN(idx) || idx < 0 || idx > 2) return res.status(400).json({ error: "bad_index" });
    const { name, token, syncFromDate } = req.body || {};
    const shops = getKaspiShops();
    if (typeof name === "string" && name.trim()) shops[idx].name = name.trim();
    if (typeof token === "string" && token.trim()) shops[idx].token = token.trim();
    if (typeof syncFromDate === "string") shops[idx].syncFromDate = syncFromDate;
    setKaspiShops(shops);
    res.json({ ok: true });
  } catch (err) {
    console.error("[settings/kaspi] Ошибка:", err.message, err.stack);
    res.status(500).json({ error: "internal_error", message: err.message });
  }
});

export default router;

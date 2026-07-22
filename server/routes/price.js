import express from "express";
import { db } from "../db.js";
import { requireAuth } from "../middleware/auth.js";

const router = express.Router();
router.use(requireAuth);

function uid() {
  return "p" + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

router.get("/", async (req, res) => {
  await db.read();
  res.json(db.data.priceItems);
});

router.post("/", async (req, res) => {
  await db.read();
  const item = { ...req.body, id: uid(), createdAt: new Date().toISOString() };
  db.data.priceItems.push(item);
  if (item.type && !db.data.categories.includes(item.type)) {
    db.data.categories.push(item.type);
  }
  await db.write();
  res.json(item);
});

router.put("/:id", async (req, res) => {
  await db.read();
  const idx = db.data.priceItems.findIndex(p => p.id === req.params.id);
  if (idx < 0) return res.status(404).json({ error: "not_found" });
  db.data.priceItems[idx] = { ...db.data.priceItems[idx], ...req.body, id: req.params.id };
  if (req.body.type && !db.data.categories.includes(req.body.type)) {
    db.data.categories.push(req.body.type);
  }
  await db.write();
  res.json(db.data.priceItems[idx]);
});

router.delete("/:id", async (req, res) => {
  await db.read();
  db.data.priceItems = db.data.priceItems.filter(p => p.id !== req.params.id);
  await db.write();
  res.json({ ok: true });
});

router.get("/categories/list", async (req, res) => {
  await db.read();
  res.json(db.data.categories);
});

router.post("/categories/list", async (req, res) => {
  const { name } = req.body || {};
  if (!name || !name.trim()) return res.status(400).json({ error: "invalid_name" });
  await db.read();
  if (!db.data.categories.includes(name.trim())) {
    db.data.categories.push(name.trim());
    await db.write();
  }
  res.json(db.data.categories);
});

export default router;

import express from "express";
import { db } from "../db.js";
import { requireAuth } from "../middleware/auth.js";

const router = express.Router();
router.use(requireAuth);

function uid() {
  return "o" + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

router.get("/", async (req, res) => {
  await db.read();
  const { source } = req.query;
  let list = db.data.orders;
  if (source) list = list.filter(o => (o.source || "manual") === source);
  res.json(list);
});

router.post("/", async (req, res) => {
  await db.read();
  const receiptNumber = db.data.meta.nextReceiptNumber++;
  const order = { ...req.body, id: uid(), source: "manual", receiptNumber, createdAt: new Date().toISOString() };
  db.data.orders.push(order);
  await db.write();
  res.json(order);
});

router.put("/:id", async (req, res) => {
  await db.read();
  const idx = db.data.orders.findIndex(o => o.id === req.params.id);
  if (idx < 0) return res.status(404).json({ error: "not_found" });
  db.data.orders[idx] = { ...db.data.orders[idx], ...req.body, id: req.params.id };
  await db.write();
  res.json(db.data.orders[idx]);
});

router.delete("/:id", async (req, res) => {
  await db.read();
  db.data.orders = db.data.orders.filter(o => o.id !== req.params.id);
  await db.write();
  res.json({ ok: true });
});

export default router;

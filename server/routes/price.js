import express from "express";
import { db, logAudit } from "../db.js";
import { requireAuth } from "../middleware/auth.js";

const router = express.Router();
router.use(requireAuth);

function uid() {
  return "p" + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

function rowToPrice(row) {
  if (!row) return null;
  return {
    id: row.id, article: row.article, name: row.name, type: row.type, color: row.color,
    height: row.height, diameter: row.diameter, weight: row.weight, material: row.material,
    mount: row.mount, buyPriceKzt: row.buy_price_kzt, deliveryPrice: row.delivery_price,
    wholesale: row.wholesale, retail: row.retail, cost: row.cost, note: row.note,
    photo: row.photo, photoName: row.photo_name, createdAt: row.created_at
  };
}

function ensureCategory(type) {
  if (!type) return;
  db.prepare("INSERT OR IGNORE INTO categories (name) VALUES (?)").run(type);
}

router.get("/", (req, res) => {
  try{
    const rows = db.prepare("SELECT * FROM price_items").all();
    res.json(rows.map(rowToPrice));
  }catch(err){
    console.error("[price GET /] Ошибка:", err.message, err.stack);
    res.status(500).json({ error: "internal_error", message: err.message });
  }
});

router.post("/", (req, res) => {
  const b = req.body || {};
  const id = uid();
  const cost = (Number(b.buyPriceKzt) || 0) + (Number(b.deliveryPrice) || 0);
  db.prepare(`INSERT INTO price_items
    (id, article, name, type, color, height, diameter, weight, material, mount,
     buy_price_kzt, delivery_price, wholesale, retail, cost, note, photo, photo_name, created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(id, b.article || "", b.name || "", b.type || "", b.color || "",
         b.height || 0, b.diameter || 0, b.weight || 0, b.material || "", b.mount || "",
         b.buyPriceKzt || 0, b.deliveryPrice || 0, b.wholesale || 0, b.retail || 0, cost,
         b.note || "", b.photo || null, b.photoName || "", new Date().toISOString());
  ensureCategory(b.type);
  logAudit({ user: req.session.username, action: "create_price_item", newValue: b.name || b.article });
  res.json(rowToPrice(db.prepare("SELECT * FROM price_items WHERE id = ?").get(id)));
});

router.put("/:id", (req, res) => {
  const row = db.prepare("SELECT * FROM price_items WHERE id = ?").get(req.params.id);
  if (!row) return res.status(404).json({ error: "not_found" });
  const b = req.body || {};
  const cost = (Number(b.buyPriceKzt ?? row.buy_price_kzt) || 0) + (Number(b.deliveryPrice ?? row.delivery_price) || 0);
  db.prepare(`UPDATE price_items SET
    article=?, name=?, type=?, color=?, height=?, diameter=?, weight=?, material=?, mount=?,
    buy_price_kzt=?, delivery_price=?, wholesale=?, retail=?, cost=?, note=?, photo=?, photo_name=?
    WHERE id=?`)
    .run(
      b.article ?? row.article, b.name ?? row.name, b.type ?? row.type, b.color ?? row.color,
      b.height ?? row.height, b.diameter ?? row.diameter, b.weight ?? row.weight,
      b.material ?? row.material, b.mount ?? row.mount,
      b.buyPriceKzt ?? row.buy_price_kzt, b.deliveryPrice ?? row.delivery_price,
      b.wholesale ?? row.wholesale, b.retail ?? row.retail, cost,
      b.note ?? row.note, b.photo ?? row.photo, b.photoName ?? row.photo_name,
      req.params.id
    );
  if (b.type) ensureCategory(b.type);
  res.json(rowToPrice(db.prepare("SELECT * FROM price_items WHERE id = ?").get(req.params.id)));
});

router.delete("/:id", (req, res) => {
  db.prepare("DELETE FROM price_items WHERE id = ?").run(req.params.id);
  logAudit({ user: req.session.username, action: "delete_price_item" });
  res.json({ ok: true });
});

router.get("/categories/list", (req, res) => {
  try{
    const rows = db.prepare("SELECT name FROM categories ORDER BY name ASC").all();
    res.json(rows.map(r => r.name));
  }catch(err){
    console.error("[price GET /categories/list] Ошибка:", err.message, err.stack);
    res.status(500).json({ error: "internal_error", message: err.message });
  }
});

router.post("/categories/list", (req, res) => {
  const { name } = req.body || {};
  if (!name || !name.trim()) return res.status(400).json({ error: "invalid_name" });
  db.prepare("INSERT OR IGNORE INTO categories (name) VALUES (?)").run(name.trim());
  const rows = db.prepare("SELECT name FROM categories ORDER BY name ASC").all();
  res.json(rows.map(r => r.name));
});

router.delete("/categories/:name", (req, res) => {
  try {
    db.prepare("DELETE FROM categories WHERE name = ?").run(req.params.name);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: "internal_error", message: err.message });
  }
});

export default router;

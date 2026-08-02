import express from "express";
import { db, logAudit } from "../db.js";
import { requireAuth, requirePermission } from "../middleware/auth.js";

const router = express.Router();
router.use(requireAuth);
router.use(requirePermission("production"));

function uid(prefix) { return prefix + "_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }
function num(v) { const n = Number(v); return Number.isFinite(n) ? n : 0; }
function str(v, max = 300) { return String(v == null ? "" : v).replace(/[\r\n\t]+/g, " ").trim().slice(0, max); }

const SOURCE_LABEL = {
  overproduced: "сшито на запас",
  returned: "вернулось с возврата",
  cancelled: "с отменённого заказа"
};

// Остатки: одна строка на артикул, чтобы менеджер видел «чего и сколько есть»,
// а не список отдельных поступлений
router.get("/", (req, res) => {
  const withConsumed = req.query.consumed === "1";
  const rows = db.prepare(`SELECT * FROM warehouse_stock ${withConsumed ? "" : "WHERE consumed = 0"} ORDER BY created_at DESC`).all();

  const byArticle = new Map();
  for (const r of rows) {
    const key = String(r.article || "").trim() || String(r.product_name || "—");
    if (!byArticle.has(key)) {
      const item = r.article ? db.prepare("SELECT name, photo, retail, labor_rate, type FROM price_items WHERE article = ?").get(r.article) : null;
      byArticle.set(key, {
        article: r.article || "", name: item?.name || r.product_name || "—",
        photo: item?.photo || null, category: item?.type || "", retail: num(item?.retail),
        laborRate: num(item?.labor_rate), qty: 0, bySource: {}, items: []
      });
    }
    const g = byArticle.get(key);
    const q = num(r.qty) || 1;
    g.qty += q;
    g.bySource[r.source || "overproduced"] = (g.bySource[r.source || "overproduced"] || 0) + q;
    g.items.push({
      id: r.id, qty: q, source: r.source, sourceLabel: SOURCE_LABEL[r.source] || r.source || "—",
      createdAt: r.created_at, consumed: !!r.consumed, sourceOrderId: r.source_order_id
    });
  }

  const groups = Array.from(byArticle.values()).sort((a, b) => (a.category || "").localeCompare(b.category || "", "ru") || a.name.localeCompare(b.name, "ru"));
  res.json({
    groups,
    totals: {
      positions: groups.length,
      units: groups.reduce((s, g) => s + g.qty, 0),
      // Во что оценивается склад по рознице — грубо, но понятно
      retailValue: Math.round(groups.reduce((s, g) => s + g.qty * g.retail, 0)),
      bySource: groups.reduce((acc, g) => {
        for (const [k, v] of Object.entries(g.bySource)) acc[k] = (acc[k] || 0) + v;
        return acc;
      }, {})
    }
  });
});

// Ручное добавление на склад: например, нашли изделие, которого не было в учёте
router.post("/", (req, res) => {
  const b = req.body || {};
  const article = str(b.article, 60);
  if (!article) return res.status(400).json({ error: "article_required", message: "Выберите товар" });
  const item = db.prepare("SELECT * FROM price_items WHERE article = ?").get(article);
  const qty = Math.max(1, num(b.qty) || 1);
  const id = uid("ws");
  db.prepare(`INSERT INTO warehouse_stock (id, article, product_name, source, qty, consumed, created_at)
              VALUES (?,?,?,?,?,0,?)`)
    .run(id, article, item ? (item.name || item.kaspi_name) : str(b.name, 200),
         ["overproduced", "returned", "cancelled"].includes(b.source) ? b.source : "overproduced",
         qty, new Date().toISOString());
  logAudit({ user: req.session.username, action: "warehouse_add", comment: `${article} ×${qty}` });
  res.json({ ok: true, id });
});

// Списание со склада. Тут же решается вопрос оплаты: за изделие с возврата
// платить не нужно, за сшитое на запас — тоже, работа уже оплачена.
router.post("/:id/consume", (req, res) => {
  const row = db.prepare("SELECT * FROM warehouse_stock WHERE id = ?").get(req.params.id);
  if (!row) return res.status(404).json({ error: "not_found" });
  if (row.consumed) return res.status(400).json({ error: "already", message: "Эта позиция уже списана" });

  const orderId = str(req.body?.orderId, 60) || null;
  db.prepare("UPDATE warehouse_stock SET consumed = 1, consumed_by_order_id = ? WHERE id = ?").run(orderId, row.id);

  // Если списываем под заказ — закрываем и запись в производстве, чтобы она
  // не висела «ждёт решения»
  if (orderId) {
    const prod = db.prepare("SELECT * FROM production WHERE order_id = ? AND decision IS NULL").get(orderId);
    if (prod) {
      db.prepare("UPDATE production SET decision = 'stock', resolved_at = ? WHERE id = ?")
        .run(new Date().toISOString(), prod.id);
    }
  }
  logAudit({ user: req.session.username, action: "warehouse_consume",
             comment: `${row.article || row.product_name}${orderId ? " → заказ" : ""}` });
  res.json({ ok: true });
});

// Заказы, ждущие решения — чтобы списать со склада прямо в нужный заказ
router.get("/pending-orders", (req, res) => {
  const rows = db.prepare(`SELECT p.id AS production_id, p.article, p.product_name, p.quantity,
                                  o.id AS order_id, o.display_number, o.shop
                           FROM production p LEFT JOIN orders o ON o.id = p.order_id
                           WHERE p.decision IS NULL ORDER BY o.display_number`).all();
  res.json(rows.map(r => ({
    productionId: r.production_id, orderId: r.order_id, number: r.display_number,
    shop: r.shop, article: r.article, name: r.product_name, qty: num(r.quantity) || 1
  })));
});

export default router;

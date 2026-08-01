import express from "express";
import { db, logAudit } from "../db.js";
import { requireAuth } from "../middleware/auth.js";

const router = express.Router();
router.use(requireAuth);

function uid() {
  return "cat_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

// Справочник = таблица price_items (та же, что и "Прайс"), просто с добавленными
// полями от Kaspi. article используется как SKU для сопоставления при импорте.
function rowToCatalogItem(row) {
  if (!row) return null;
  return {
    id: row.id,
    article: row.article,           // SKU (из Kaspi или введённый вручную)
    printName: row.name,            // "Название для печати" — ручное поле
    category: row.type,             // категория — ручное поле
    subgroup: row.subgroup,         // подраздел (второй уровень группировки) — ручное поле
    material: row.material,
    color: row.color,
    height: row.height,
    diameter: row.diameter,
    weight: row.weight,
    mount: row.mount,               // крепление/кольцо (для груш и т.п.)
    laborRate: row.labor_rate,      // расценка труда за 1 шт — читает "Зарплата"
    materialCost: row.material_cost,
    miscCost: row.misc_cost,
    ragsCost: row.rags_cost,
    note: row.note,
    costPrice: row.cost,            // себестоимость — ручное поле
    retailPrice: row.retail,        // наша розничная цена — ручное поле
    photo: row.photo,
    kaspiName: row.kaspi_name,              // сырое название с Kaspi (авто)
    kaspiPrice: row.kaspi_price,            // цена на Kaspi (авто)
    inStockPoints: row.kaspi_in_stock_points,
    totalPoints: row.kaspi_total_points,
    preorderDays: row.kaspi_preorder_days,
    syncedAt: row.kaspi_synced_at,
    showInPrice: row.show_in_price !== 0, // по умолчанию true (в базе default 1)
    sortOrder: row.sort_order || 0,
    createdAt: row.created_at
  };
}

router.get("/", (req, res) => {
  const rows = db.prepare(
    "SELECT * FROM price_items ORDER BY kaspi_synced_at DESC, created_at DESC"
  ).all();
  res.json(rows.map(rowToCatalogItem));
});

// Импорт выгрузки Kaspi "Активные товары" — принимает уже распарсенный на
// клиенте массив строк (SheetJS разбирает файл в браузере, сюда прилетает JSON).
// Апсерт по article (= SKU из Kaspi). Ручные поля (name/type/cost/retail)
// НИКОГДА не трогаются этим импортом — обновляются только kaspi_* колонки.
router.post("/import", (req, res) => {
  const items = Array.isArray(req.body?.items) ? req.body.items : [];
  if (!items.length) return res.status(400).json({ error: "empty_items", message: "Список товаров пуст" });

  const now = new Date().toISOString();
  let added = 0, updated = 0, skipped = 0;

  for (const it of items) {
    const sku = String(it.sku || "").trim();
    if (!sku) { skipped++; continue; }
    const kaspiName = String(it.kaspiName || "").trim();
    const kaspiPrice = Number(it.kaspiPrice) || 0;
    const inStockPoints = Number(it.inStockPoints) || 0;
    const totalPoints = Number(it.totalPoints) || 0;
    const preorderDays = Number(it.preorderDays) || 0;

    const existing = db.prepare("SELECT id FROM price_items WHERE article = ?").get(sku);
    if (existing) {
      db.prepare(`UPDATE price_items SET
        kaspi_name=?, kaspi_price=?, kaspi_in_stock_points=?, kaspi_total_points=?,
        kaspi_preorder_days=?, kaspi_synced_at=? WHERE id=?`)
        .run(kaspiName, kaspiPrice, inStockPoints, totalPoints, preorderDays, now, existing.id);
      updated++;
    } else {
      db.prepare(`INSERT INTO price_items
        (id, article, name, type, retail, cost,
         kaspi_name, kaspi_price, kaspi_in_stock_points, kaspi_total_points, kaspi_preorder_days,
         kaspi_synced_at, created_at)
        VALUES (?, ?, '', '', 0, NULL, ?, ?, ?, ?, ?, ?, ?)`)
        .run(uid(), sku, kaspiName, kaspiPrice, inStockPoints, totalPoints, preorderDays, now, now);
      added++;
    }
  }

  logAudit({ user: req.session.username, action: "catalog_import", comment: `+${added} ~${updated} (пропущено: ${skipped})` });
  res.json({ added, updated, skipped });
});

// Наполнение Справочника из заказов Kaspi — по обоим магазинам сразу.
// Каталога товаров Kaspi в API не отдаёт, зато в заказах есть артикул и
// название каждой позиции: этого достаточно, чтобы товар появился в
// Справочнике сам, без выгрузки Excel. Ручные поля (название для печати,
// цены, расценка труда) НИКОГДА не перезаписываются.
router.post("/sync-from-orders", (req, res) => {
  const rows = db.prepare("SELECT * FROM orders WHERE source = 'kaspi' OR kaspi_code LIKE 'УД-%'").all();
  const now = new Date().toISOString();
  let added = 0, updated = 0, skipped = 0;
  const shopsByArticle = new Map();

  for (const o of rows) {
    // Артикул: сначала из позиций заказа (там он настоящий, от Kaspi),
    // потом — из самого заказа, как у ручных УД
    let article = String(o.article || "").trim();
    let name = String(o.product_name || o.name || "").trim();
    let price = Number(o.total_price) || 0;
    try {
      const entries = o.entries_raw ? JSON.parse(o.entries_raw) : null;
      const attr = entries?.data?.[0]?.attributes;
      if (attr?.offer?.code) article = String(attr.offer.code).trim();
      if (attr?.offer?.name) name = String(attr.offer.name).trim();
      if (attr?.basePrice) price = Number(attr.basePrice) || price;
    } catch (e) { /* сырых данных нет или битые — работаем по колонкам заказа */ }

    if (!article) { skipped++; continue; }
    if (o.shop) {
      if (!shopsByArticle.has(article)) shopsByArticle.set(article, new Set());
      shopsByArticle.get(article).add(o.shop);
    }

    const existing = db.prepare("SELECT * FROM price_items WHERE article = ?").get(article);
    if (existing) {
      // Обновляем только справочные kaspi_* поля, ручное не трогаем
      db.prepare("UPDATE price_items SET kaspi_name = ?, kaspi_price = ?, kaspi_synced_at = ? WHERE id = ?")
        .run(name || existing.kaspi_name, price || existing.kaspi_price, now, existing.id);
      updated++;
    } else {
      db.prepare(`INSERT INTO price_items (id, article, name, type, retail, cost, kaspi_name, kaspi_price, kaspi_synced_at, created_at)
                  VALUES (?, ?, '', '', 0, NULL, ?, ?, ?, ?)`)
        .run(uid(), article, name, price, now, now);
      added++;
    }
  }

  logAudit({ user: req.session.username, action: "catalog_sync_orders", comment: `+${added} ~${updated}` });
  res.json({
    added, updated, skipped,
    shops: Array.from(new Set(rows.map(o => o.shop).filter(Boolean)))
  });
});

// Ручное добавление товара — для того, чего в Kaspi ещё нет
router.post("/", (req, res) => {
  const b = req.body || {};
  const article = String(b.article || "").trim();
  if (!article) return res.status(400).json({ error: "article_required", message: "Укажите артикул — по нему товар связывается с заказами" });
  const exists = db.prepare("SELECT id FROM price_items WHERE article = ?").get(article);
  if (exists) return res.status(400).json({ error: "duplicate", message: `Товар с артикулом ${article} уже есть в Справочнике` });

  const id = uid();
  const now = new Date().toISOString();
  db.prepare(`INSERT INTO price_items (id, article, name, type, subgroup, material, retail, cost, photo, created_at)
              VALUES (?,?,?,?,?,?,?,?,?,?)`)
    .run(id, article, String(b.printName || "").trim(), String(b.category || "").trim(),
         String(b.subgroup || "").trim(), String(b.material || "").trim(),
         Number(b.retailPrice) || 0, null, b.photo || null, now);
  logAudit({ user: req.session.username, action: "catalog_create", comment: `${article} — ${b.printName || ""}` });
  res.json(rowToCatalogItem(db.prepare("SELECT * FROM price_items WHERE id = ?").get(id)));
});

// Точечное обновление ручных полей: название для печати, категория,
// себестоимость, розница. Через тот же маршрут, что уже был у "Прайса"
// (price.js), эта запись не трогается — правим напрямую здесь.
router.put("/:id", (req, res) => {
  const row = db.prepare("SELECT * FROM price_items WHERE id = ?").get(req.params.id);
  if (!row) return res.status(404).json({ error: "not_found" });
  const b = req.body || {};

  const updates = [];
  const params = [];
  const map = {
    printName: "name", category: "type", subgroup: "subgroup",
    material: "material", color: "color", height: "height", diameter: "diameter",
    weight: "weight", mount: "mount", note: "note", photo: "photo",
    laborRate: "labor_rate", materialCost: "material_cost", miscCost: "misc_cost", ragsCost: "rags_cost",
    costPrice: "cost", retailPrice: "retail", sortOrder: "sort_order"
  };
  const numericFields = new Set(["height","diameter","weight","laborRate","materialCost","miscCost","ragsCost","costPrice","retailPrice","sortOrder"]);
  for (const [jsKey, col] of Object.entries(map)) {
    if (Object.prototype.hasOwnProperty.call(b, jsKey)) {
      updates.push(`${col} = ?`);
      let v = b[jsKey];
      if (numericFields.has(jsKey) && v !== null && v !== "") v = Number(v) || 0;
      if (numericFields.has(jsKey) && v === "") v = null;
      params.push(v);
    }
  }
  if (Object.prototype.hasOwnProperty.call(b, "showInPrice")) {
    updates.push("show_in_price = ?");
    params.push(b.showInPrice ? 1 : 0);
  }
  if (updates.length) {
    params.push(req.params.id);
    db.prepare(`UPDATE price_items SET ${updates.join(", ")} WHERE id = ?`).run(...params);
  }
  const updated = db.prepare("SELECT * FROM price_items WHERE id = ?").get(req.params.id);
  res.json(rowToCatalogItem(updated));
});

// Удаление позиции из справочника (в т.ч. тех, что попали туда через "Прайс" —
// это одна и та же таблица, удаление отсюда работает независимо от того,
// откуда запись изначально появилась)
router.delete("/:id", (req, res) => {
  const row = db.prepare("SELECT * FROM price_items WHERE id = ?").get(req.params.id);
  if (!row) return res.status(404).json({ error: "not_found" });
  db.prepare("DELETE FROM price_items WHERE id = ?").run(req.params.id);
  logAudit({
    user: req.session.username,
    action: "catalog_delete",
    comment: `${row.article || ""} — ${row.name || row.kaspi_name || ""}`
  });
  res.json({ ok: true });
});

// Массовое обновление ручных полей — сценарий "выгрузили в Excel, заполнили
// материалы/расценки/группы для многих товаров разом, загружаем обратно".
// Сопоставление по article (SKU). НЕ создаёт новые позиции и не трогает
// kaspi_* поля — только уже существующие строки и только ручные колонки.
router.post("/bulk-update", (req, res) => {
  const items = Array.isArray(req.body?.items) ? req.body.items : [];
  if (!items.length) return res.status(400).json({ error: "empty_items", message: "Список пуст" });

  const map = {
    printName: "name", category: "type", subgroup: "subgroup",
    material: "material", color: "color", height: "height", diameter: "diameter",
    weight: "weight", mount: "mount", note: "note",
    laborRate: "labor_rate", materialCost: "material_cost", miscCost: "misc_cost", ragsCost: "rags_cost",
    costPrice: "cost", retailPrice: "retail"
  };
  const numericFields = new Set(["height","diameter","weight","laborRate","materialCost","miscCost","ragsCost","costPrice","retailPrice"]);

  let updated = 0, notFound = 0;
  for (const it of items) {
    const sku = String(it.article || "").trim();
    if (!sku) continue;
    const existing = db.prepare("SELECT id FROM price_items WHERE article = ?").get(sku);
    if (!existing) { notFound++; continue; }

    const updates = [];
    const params = [];
    for (const [jsKey, col] of Object.entries(map)) {
      if (Object.prototype.hasOwnProperty.call(it, jsKey)) {
        updates.push(`${col} = ?`);
        let v = it[jsKey];
        if (numericFields.has(jsKey) && v !== null && v !== "") v = Number(v) || 0;
        if (numericFields.has(jsKey) && (v === "" || v === undefined)) v = null;
        params.push(v);
      }
    }
    if (updates.length) {
      params.push(existing.id);
      db.prepare(`UPDATE price_items SET ${updates.join(", ")} WHERE id = ?`).run(...params);
      updated++;
    }
  }
  logAudit({ user: req.session.username, action: "catalog_bulk_update", comment: `~${updated} (не найдено: ${notFound})` });
  res.json({ updated, notFound });
});

export default router;

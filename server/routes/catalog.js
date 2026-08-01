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

import express from "express";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
import { db, logAudit } from "../db.js";
import { requireAuth } from "../middleware/auth.js";

// Постоянный диск определяем по тому, что путь лежит ВНЕ папки приложения.
// Раньше проверялся только /var/data, а Render разрешает любую точку
// монтирования — например /data, и программа зря пугала потерей данных.
function isPersistent(p) {
  const s = String(p || "");
  if (!s.startsWith("/")) return false;
  return !s.startsWith("/opt/render/project") && !s.startsWith(process.cwd()) && !s.startsWith("/tmp");
}

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
    laborRate: row.labor_rate,      // ОБЩАЯ расценка труда за 1 шт — читает "Зарплата"
    sewRate: row.sew_rate,          // сколько из неё достаётся швее; остальное — забивщику
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
    isArchived: row.is_archived === 1,
    gtin: row.gtin,
    deliveryCost: row.delivery_cost,
    taxPercent: row.tax_percent,
    sortOrder: row.sort_order || 0,
    createdAt: row.created_at
  };
}

router.get("/", (req, res) => {
  const withArchived = req.query.archived === "1";
  const rows = db.prepare(
    `SELECT * FROM price_items ${withArchived ? "" : "WHERE COALESCE(is_archived,0) = 0"}
     ORDER BY kaspi_synced_at DESC, created_at DESC`
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
  res.json({ added, updated, skipped, shops: Array.from(new Set(rows.map(o => o.shop).filter(Boolean))) });
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

// Перенос цен Kaspi в розницу: цена на Kaspi уже есть у каждого товара,
// а розница у большинства пустая — руками её перебивать долго.
router.post("/kaspi-price-to-retail", (req, res) => {
  const onlyEmpty = req.body?.onlyEmpty !== false; // по умолчанию не трогаем уже заполненные
  const rows = db.prepare("SELECT * FROM price_items WHERE kaspi_price > 0").all();
  let updated = 0, skipped = 0;
  for (const row of rows) {
    if (onlyEmpty && Number(row.retail) > 0) { skipped++; continue; }
    db.prepare("UPDATE price_items SET retail = ? WHERE id = ?").run(Number(row.kaspi_price), row.id);
    updated++;
  }
  logAudit({ user: req.session.username, action: "catalog_kaspi_price_to_retail",
             comment: `Перенесено цен: ${updated}${skipped ? `, пропущено заполненных: ${skipped}` : ""}` });
  res.json({ updated, skipped, total: rows.length });
});

// Проверка загрузки фото: куда пишем, доступна ли папка, сколько там файлов.
// Нужна, когда фото «не грузятся» — сразу видно, дело в правах или в другом.
router.get("/photos-status", (req, res) => {
  const dir = process.env.UPLOAD_DIR || path.join(__dirname, "..", "uploads");
  const result = { dir, exists: false, writable: false, files: 0, sizeMb: 0, onPersistentDisk: isPersistent(dir) };
  try {
    result.exists = fs.existsSync(dir);
    if (result.exists) {
      const names = fs.readdirSync(dir).filter(f => fs.statSync(path.join(dir, f)).isFile());
      result.files = names.length;
      result.sizeMb = Math.round(names.reduce((s, f) => s + fs.statSync(path.join(dir, f)).size, 0) / 104857.6) / 10;
    }
    const probe = path.join(dir, ".write-test");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(probe, "x");
    fs.unlinkSync(probe);
    result.writable = true;
  } catch (e) {
    result.error = e.message;
  }
  // Сколько товаров ссылается на фото, которых физически нет
  let broken = 0;
  for (const row of db.prepare("SELECT photo FROM price_items WHERE photo IS NOT NULL AND photo != ''").all()) {
    const name = String(row.photo).replace(/^\/uploads\//, "");
    if (!fs.existsSync(path.join(dir, name))) broken++;
  }
  result.brokenLinks = broken;
  res.json(result);
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
    weight: "weight", mount: "mount", note: "note", photo: "photo", gtin: "gtin",
    deliveryCost: "delivery_cost", taxPercent: "tax_percent",
    laborRate: "labor_rate", sewRate: "sew_rate", materialCost: "material_cost", miscCost: "misc_cost", ragsCost: "rags_cost",
    costPrice: "cost", retailPrice: "retail", sortOrder: "sort_order"
  };
  const numericFields = new Set(["height","diameter","weight","laborRate","materialCost","miscCost","ragsCost","costPrice","retailPrice","sortOrder","deliveryCost","taxPercent"]);
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
  if (Object.prototype.hasOwnProperty.call(b, "isArchived")) {
    updates.push("is_archived = ?");
    params.push(b.isArchived ? 1 : 0);
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
router.post("/bulk-update", async (req, res) => {
  const items = Array.isArray(req.body?.items) ? req.body.items : [];
  if (!items.length) return res.status(400).json({ error: "empty_items", message: "Список пуст" });

  // Перед массовой загрузкой делаем снимок базы: если файл окажется кривым,
  // можно откатиться одной кнопкой, а не восстанавливать вручную
  let snapshot = null;
  try {
    const mod = await import("./backup.js");
    if (typeof mod.makeSnapshot === "function") snapshot = mod.makeSnapshot("передЗагрузкойСправочника");
  } catch (e) { /* модуль копий не залит — загрузку всё равно делаем */ }

  const map = {
    printName: "name", category: "type", subgroup: "subgroup",
    material: "material", color: "color", height: "height", diameter: "diameter",
    weight: "weight", mount: "mount", note: "note", gtin: "gtin",
    deliveryCost: "delivery_cost", taxPercent: "tax_percent",
    laborRate: "labor_rate", sewRate: "sew_rate", materialCost: "material_cost", miscCost: "misc_cost", ragsCost: "rags_cost",
    costPrice: "cost", retailPrice: "retail"
  };
  const numericFields = new Set(["height","diameter","weight","laborRate","materialCost","miscCost","ragsCost","costPrice","retailPrice","deliveryCost","taxPercent"]);

  // createMissing = true: строки с новым артикулом заводятся как новые товары.
  // Так из старой системы можно залить весь каталог разом, а не по одному.
  const createMissing = req.body?.createMissing !== false;
  let updated = 0, notFound = 0, created = 0;
  for (const it of items) {
    const sku = String(it.article || "").trim();
    if (!sku) continue;
    let existing = db.prepare("SELECT id FROM price_items WHERE article = ?").get(sku);
    if (!existing) {
      if (!createMissing) { notFound++; continue; }
      const id = uid();
      db.prepare(`INSERT INTO price_items (id, article, name, type, retail, cost, created_at)
                  VALUES (?, ?, '', '', 0, NULL, ?)`).run(id, sku, new Date().toISOString());
      existing = { id };
      created++;
    }

    const updates = [];
    const params = [];
    // ГЛАВНОЕ ПРАВИЛО: пустая ячейка в файле ничего не стирает.
    // Иначе выгрузил файл, заполнил один столбец, загрузил — и всё остальное
    // обнулилось. Чтобы очистить поле, есть карточка товара.
    for (const [jsKey, col] of Object.entries(map)) {
      if (!Object.prototype.hasOwnProperty.call(it, jsKey)) continue;
      let v = it[jsKey];
      const isEmpty = v === null || v === undefined || String(v).trim() === "";
      if (isEmpty) continue;
      if (numericFields.has(jsKey)) v = Number(v) || 0;
      updates.push(`${col} = ?`);
      params.push(v);
    }
    // «В прайсе» — колонка с «да»/«нет», её пустое значение тоже не трогаем
    if (Object.prototype.hasOwnProperty.call(it, "showInPrice") && it.showInPrice !== null && it.showInPrice !== undefined && String(it.showInPrice).trim() !== "") {
      const yes = /^(да|yes|1|true|\+|показывать)$/i.test(String(it.showInPrice).trim());
      updates.push("show_in_price = ?");
      params.push(yes ? 1 : 0);
    }
    if (updates.length) {
      params.push(existing.id);
      db.prepare(`UPDATE price_items SET ${updates.join(", ")} WHERE id = ?`).run(...params);
      updated++;
    }
  }
  logAudit({ user: req.session.username, action: "catalog_bulk_update",
             comment: `~${updated}, новых ${created}${notFound ? `, не найдено ${notFound}` : ""}` });
  res.json({ updated, created, notFound, snapshot });
});

export default router;

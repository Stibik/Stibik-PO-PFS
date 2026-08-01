import express from "express";
import { db, logAudit } from "../db.js";
import { requireAuth } from "../middleware/auth.js";

const router = express.Router();
router.use(requireAuth);

function uid(prefix) {
  return prefix + "_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

function safeParse(json, fallback) {
  if (!json) return fallback;
  try { return JSON.parse(json); } catch (e) { return fallback; }
}

// Список id товаров прайса в сохранённом порядке
function listItemIds(priceListId) {
  return db.prepare("SELECT item_id FROM price_list_items WHERE price_list_id = ? ORDER BY sort_order")
    .all(priceListId).map(r => r.item_id);
}

// Перезаписываем состав прайса целиком: так проще и надёжнее, чем вычислять
// разницу, а объёмы тут маленькие (десятки позиций)
function replaceItems(priceListId, itemIds, withSnapshot) {
  db.prepare("DELETE FROM price_list_items WHERE price_list_id = ?").run(priceListId);
  const insert = db.prepare("INSERT INTO price_list_items (id, price_list_id, item_id, sort_order, snapshot) VALUES (?,?,?,?,?)");
  itemIds.forEach((itemId, i) => {
    let snapshot = null;
    if (withSnapshot) {
      const row = db.prepare("SELECT * FROM price_items WHERE id = ?").get(itemId);
      if (row) {
        // Снимок цен и характеристик на момент сохранения — чтобы уже отданный
        // клиенту документ не поменялся задним числом после правки Справочника
        snapshot = JSON.stringify({
          printName: row.name, article: row.article, category: row.type, subgroup: row.subgroup,
          material: row.material, height: row.height, diameter: row.diameter, weight: row.weight,
          retailPrice: row.retail, photo: row.photo, sortOrder: row.sort_order || 0
        });
      }
    }
    insert.run(uid("pli"), priceListId, itemId, i, snapshot);
  });
}

function companySnapshot(companyId) {
  const c = db.prepare("SELECT * FROM companies WHERE id = ?").get(companyId);
  if (!c) return null;
  return JSON.stringify({
    shortName: c.short_name, fullName: c.full_name, bin: c.bin, address: c.address,
    bankName: c.bank_name, bik: c.bik, iban: c.iban, kbe: c.kbe,
    phone: c.phone, email: c.email, website: c.website, logo: c.logo, extraText: c.extra_text
  });
}

// ---------- Черновик текущего пользователя ----------
// Живёт на сервере, а не в браузере: сел за другой компьютер под своим логином —
// продолжил с того же места.
router.get("/draft", (req, res) => {
  const row = db.prepare("SELECT * FROM price_lists WHERE owner = ? AND kind = 'draft'").get(req.session.username);
  if (!row) return res.json({ exists: false });
  res.json({
    exists: true,
    id: row.id,
    name: row.name || "",
    companyId: row.company_id || "",
    settings: safeParse(row.settings, null),
    itemIds: listItemIds(row.id),
    updatedAt: row.updated_at
  });
});

router.put("/draft", (req, res) => {
  const b = req.body || {};
  const itemIds = Array.isArray(b.itemIds) ? b.itemIds.filter(x => typeof x === "string").slice(0, 2000) : [];
  const name = String(b.name || "").replace(/[\r\n\t]+/g, " ").trim().slice(0, 120);
  const companyId = String(b.companyId || "");
  const settings = JSON.stringify(b.settings && typeof b.settings === "object" ? b.settings : {});
  const now = new Date().toISOString();

  let row = db.prepare("SELECT id FROM price_lists WHERE owner = ? AND kind = 'draft'").get(req.session.username);
  if (!row) {
    const id = uid("pl");
    db.prepare(`INSERT INTO price_lists (id, name, kind, owner, company_id, settings, created_by, created_at, updated_at)
                VALUES (?,?,'draft',?,?,?,?,?,?)`)
      .run(id, name, req.session.username, companyId, settings, req.session.username, now, now);
    row = { id };
  } else {
    db.prepare("UPDATE price_lists SET name = ?, company_id = ?, settings = ?, updated_at = ? WHERE id = ?")
      .run(name, companyId, settings, now, row.id);
  }
  replaceItems(row.id, itemIds, false); // в черновике снимок не нужен — цены всегда актуальные
  res.json({ ok: true, id: row.id, updatedAt: now, count: itemIds.length });
});

// ---------- Сохранённые прайсы ----------
// Видны всем сотрудникам: смысл в том, чтобы собранный на одном рабочем месте
// прайс можно было открыть на другом.
router.get("/", (req, res) => {
  const rows = db.prepare("SELECT * FROM price_lists WHERE kind = 'saved' ORDER BY updated_at DESC").all();
  res.json(rows.map(r => {
    const company = r.company_id ? db.prepare("SELECT short_name FROM companies WHERE id = ?").get(r.company_id) : null;
    const cnt = db.prepare("SELECT COUNT(*) AS n FROM price_list_items WHERE price_list_id = ?").get(r.id);
    return {
      id: r.id,
      name: r.name || "Без названия",
      companyId: r.company_id,
      companyName: company ? company.short_name : (safeParse(r.company_snapshot, {}).shortName || ""),
      itemCount: cnt ? cnt.n : 0,
      createdBy: r.created_by,
      createdAt: r.created_at,
      updatedAt: r.updated_at
    };
  }));
});

router.get("/:id", (req, res) => {
  const row = db.prepare("SELECT * FROM price_lists WHERE id = ? AND kind = 'saved'").get(req.params.id);
  if (!row) return res.status(404).json({ error: "not_found", message: "Прайс не найден" });
  res.json({
    id: row.id,
    name: row.name || "",
    companyId: row.company_id || "",
    settings: safeParse(row.settings, null),
    itemIds: listItemIds(row.id),
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  });
});

router.post("/", (req, res) => {
  const b = req.body || {};
  const name = String(b.name || "").replace(/[\r\n\t]+/g, " ").trim().slice(0, 120);
  if (!name) return res.status(400).json({ error: "name_required", message: "Укажите название прайса" });
  const itemIds = Array.isArray(b.itemIds) ? b.itemIds.filter(x => typeof x === "string").slice(0, 2000) : [];
  if (!itemIds.length) return res.status(400).json({ error: "no_items", message: "Не выбрано ни одного товара" });
  const companyId = String(b.companyId || "");
  if (!companyId || !db.prepare("SELECT id FROM companies WHERE id = ?").get(companyId)) {
    return res.status(400).json({ error: "company_not_found", message: "Выберите компанию" });
  }

  const now = new Date().toISOString();
  const id = uid("pl");
  db.prepare(`INSERT INTO price_lists (id, name, kind, owner, company_id, settings, company_snapshot, created_by, created_at, updated_at)
              VALUES (?,?,'saved',NULL,?,?,?,?,?,?)`)
    .run(id, name, companyId,
         JSON.stringify(b.settings && typeof b.settings === "object" ? b.settings : {}),
         companySnapshot(companyId), req.session.username, now, now);
  replaceItems(id, itemIds, true);

  logAudit({ user: req.session.username, action: "price_list_save", comment: `${name} (${itemIds.length} поз.)` });
  res.json({ ok: true, id, name, itemCount: itemIds.length });
});

router.delete("/:id", (req, res) => {
  const row = db.prepare("SELECT * FROM price_lists WHERE id = ? AND kind = 'saved'").get(req.params.id);
  if (!row) return res.status(404).json({ error: "not_found" });
  // Удалять может автор или администратор — чужую работу случайно не снесёшь
  if (req.session.role !== "admin" && row.created_by !== req.session.username) {
    return res.status(403).json({ error: "forbidden", message: "Удалить может только автор прайса или администратор" });
  }
  db.prepare("DELETE FROM price_list_items WHERE price_list_id = ?").run(row.id);
  db.prepare("DELETE FROM price_lists WHERE id = ?").run(row.id);
  logAudit({ user: req.session.username, action: "price_list_delete", comment: row.name || row.id });
  res.json({ ok: true });
});

export default router;

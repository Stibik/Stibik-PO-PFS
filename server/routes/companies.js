import express from "express";
import { db } from "../db.js";
import { requireAuth } from "../middleware/auth.js";

const router = express.Router();
router.use(requireAuth);

function uid() { return "co_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 8); }

// Смотрим роль напрямую в БД по логину из сессии — не полагаемся на то, что
// именно лежит в самой сессии (могло отличаться от того, что я предполагаю).
function isAdmin(req) {
  const row = db.prepare("SELECT role FROM users WHERE username = ?").get(req.session.username);
  return !!row && row.role === "admin";
}

function rowToCompany(row) {
  return {
    id: row.id,
    shortName: row.short_name,
    fullName: row.full_name,
    bin: row.bin,
    address: row.address,
    bankName: row.bank_name,
    bik: row.bik,
    iban: row.iban,
    kbe: row.kbe,
    phone: row.phone,
    email: row.email,
    website: row.website,
    contactPerson: row.contact_person,
    logo: row.logo,
    brandColor: row.brand_color,
    extraText: row.extra_text,
    isActive: !!row.is_active,
    isDefault: !!row.is_default,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

// Список — по умолчанию только активные (для выпадающего списка на странице
// "Прайс"); ?all=1 — вообще все, включая отключённые (для админского справочника)
router.get("/", (req, res) => {
  const rows = req.query.all
    ? db.prepare("SELECT * FROM companies ORDER BY is_default DESC, short_name").all()
    : db.prepare("SELECT * FROM companies WHERE is_active = 1 ORDER BY is_default DESC, short_name").all();
  res.json(rows.map(rowToCompany));
});

router.get("/:id", (req, res) => {
  const row = db.prepare("SELECT * FROM companies WHERE id = ?").get(req.params.id);
  if (!row) return res.status(404).json({ error: "not_found" });
  res.json(rowToCompany(row));
});

router.post("/", (req, res) => {
  if (!isAdmin(req)) return res.status(403).json({ error: "forbidden", message: "Изменение компаний доступно только администратору" });
  const b = req.body || {};
  if (!b.shortName || !String(b.shortName).trim()) {
    return res.status(400).json({ error: "short_name_required", message: "Укажите краткое название компании" });
  }
  const id = uid();
  const now = new Date().toISOString();
  db.prepare(`INSERT INTO companies
    (id, short_name, full_name, bin, address, bank_name, bik, iban, kbe, phone, email, website,
     contact_person, logo, brand_color, extra_text, is_active, is_default, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 0, ?, ?)`)
    .run(id, String(b.shortName).trim(), b.fullName || "", b.bin || "", b.address || "",
         b.bankName || "", b.bik || "", b.iban || "", b.kbe || "", b.phone || "", b.email || "",
         b.website || "", b.contactPerson || "", b.logo || null, b.brandColor || "", b.extraText || "",
         now, now);
  if (b.isDefault) setDefaultCompany(id);
  const row = db.prepare("SELECT * FROM companies WHERE id = ?").get(id);
  res.json(rowToCompany(row));
});

router.put("/:id", (req, res) => {
  if (!isAdmin(req)) return res.status(403).json({ error: "forbidden", message: "Изменение компаний доступно только администратору" });
  const row = db.prepare("SELECT * FROM companies WHERE id = ?").get(req.params.id);
  if (!row) return res.status(404).json({ error: "not_found" });
  const b = req.body || {};
  const now = new Date().toISOString();

  const map = {
    shortName: "short_name", fullName: "full_name", bin: "bin", address: "address",
    bankName: "bank_name", bik: "bik", iban: "iban", kbe: "kbe", phone: "phone", email: "email",
    website: "website", contactPerson: "contact_person", logo: "logo", brandColor: "brand_color",
    extraText: "extra_text"
  };
  const sets = [];
  const params = [];
  for (const [key, col] of Object.entries(map)) {
    if (key in b) { sets.push(`${col} = ?`); params.push(b[key]); }
  }
  if (typeof b.isActive === "boolean") { sets.push("is_active = ?"); params.push(b.isActive ? 1 : 0); }
  if (sets.length) {
    sets.push("updated_at = ?"); params.push(now);
    db.prepare(`UPDATE companies SET ${sets.join(", ")} WHERE id = ?`).run(...params, req.params.id);
  }
  if (b.isDefault) setDefaultCompany(req.params.id);

  const updated = db.prepare("SELECT * FROM companies WHERE id = ?").get(req.params.id);
  res.json(rowToCompany(updated));
});

// Сделать компанию единственной "по умолчанию" — у всех остальных снимаем флаг.
// Мягко (не через уникальный индекс), но этого достаточно для одного админа.
function setDefaultCompany(id) {
  const now = new Date().toISOString();
  db.prepare("UPDATE companies SET is_default = 0, updated_at = ? WHERE id != ?").run(now, id);
  db.prepare("UPDATE companies SET is_default = 1, updated_at = ? WHERE id = ?").run(now, id);
}

// Мягкое включение/отключение — компанию физически не удаляем (чтобы не
// сломать уже сформированные ранее прайсы, если к ним привяжемся снимком).
router.post("/:id/toggle-active", (req, res) => {
  if (!isAdmin(req)) return res.status(403).json({ error: "forbidden", message: "Доступно только администратору" });
  const row = db.prepare("SELECT * FROM companies WHERE id = ?").get(req.params.id);
  if (!row) return res.status(404).json({ error: "not_found" });
  const now = new Date().toISOString();
  db.prepare("UPDATE companies SET is_active = ?, updated_at = ? WHERE id = ?").run(row.is_active ? 0 : 1, now, req.params.id);
  const updated = db.prepare("SELECT * FROM companies WHERE id = ?").get(req.params.id);
  res.json(rowToCompany(updated));
});

export default router;

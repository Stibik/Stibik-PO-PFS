import { DatabaseSync } from "node:sqlite";
import bcrypt from "bcryptjs";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = process.env.DB_PATH || path.join(__dirname, "data.sqlite");

// Убедимся, что папка для файла БД существует (важно для /data на Render)
const dbDir = path.dirname(DB_PATH);
if (!fs.existsSync(dbDir)) fs.mkdirSync(dbDir, { recursive: true });

export const db = new DatabaseSync(DB_PATH);

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  username TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'admin',
  created_at TEXT
);

CREATE TABLE IF NOT EXISTS orders (
  id TEXT PRIMARY KEY,
  source TEXT NOT NULL DEFAULT 'manual',
  kaspi_order_id TEXT UNIQUE,
  kaspi_code TEXT,
  shop TEXT,
  receipt_number INTEGER,
  display_number INTEGER,
  article TEXT,
  name TEXT,
  qty REAL,
  note TEXT,
  photo TEXT,
  receive_status TEXT DEFAULT 'transit', -- 'transit'/'arrived'/'problem' — статус "Прихода" (поставка от поставщика)
  status TEXT NOT NULL DEFAULT 'preorder', -- статус обработки заказа Kaspi (сборка/отгрузка), для source='kaspi'
  kaspi_status TEXT,
  delivery_state TEXT,
  pre_order INTEGER DEFAULT 0,
  assembled INTEGER DEFAULT 0,
  courier_transmission_date TEXT,
  courier_handover_date TEXT,
  total_price REAL,
  product_name TEXT,
  waybill_url TEXT,
  printed INTEGER DEFAULT 0,
  print_count INTEGER DEFAULT 0,
  last_printed_at TEXT,
  last_printed_by TEXT,
  claim_note TEXT,
  claim_resolved INTEGER DEFAULT 0,
  raw TEXT,
  created_at TEXT,
  updated_at TEXT
);

CREATE TABLE IF NOT EXISTS status_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id TEXT NOT NULL,
  from_status TEXT,
  to_status TEXT,
  user TEXT,
  reason TEXT,
  is_correction INTEGER DEFAULT 0,
  created_at TEXT
);

CREATE TABLE IF NOT EXISTS cargo_places (
  id TEXT PRIMARY KEY,
  order_id TEXT NOT NULL,
  place_number INTEGER,
  name TEXT,
  formed INTEGER DEFAULT 0,
  label_printed INTEGER DEFAULT 0,
  formed_at TEXT,
  formed_by TEXT,
  comment TEXT
);

CREATE TABLE IF NOT EXISTS print_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id TEXT NOT NULL,
  user TEXT,
  printed_at TEXT,
  is_reprint INTEGER DEFAULT 0,
  reason TEXT
);

CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user TEXT,
  action TEXT NOT NULL,
  order_id TEXT,
  old_value TEXT,
  new_value TEXT,
  comment TEXT,
  ip TEXT,
  created_at TEXT
);

CREATE TABLE IF NOT EXISTS price_items (
  id TEXT PRIMARY KEY,
  article TEXT,
  name TEXT,
  type TEXT,
  color TEXT,
  height REAL,
  diameter REAL,
  weight REAL,
  material TEXT,
  mount TEXT,
  buy_price_kzt REAL,
  delivery_price REAL,
  wholesale REAL,
  retail REAL,
  cost REAL,
  note TEXT,
  photo TEXT,
  photo_name TEXT,
  created_at TEXT
);

CREATE TABLE IF NOT EXISTS categories (
  name TEXT PRIMARY KEY
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT
);

CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT
);

CREATE INDEX IF NOT EXISTS idx_orders_source ON orders(source);
CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status);
CREATE INDEX IF NOT EXISTS idx_status_history_order ON status_history(order_id);
CREATE INDEX IF NOT EXISTS idx_cargo_places_order ON cargo_places(order_id);
CREATE INDEX IF NOT EXISTS idx_print_log_order ON print_log(order_id);
CREATE INDEX IF NOT EXISTS idx_audit_log_order ON audit_log(order_id);
`;

export function ensureSchema() {
  db.exec(SCHEMA);

  const kaspiShopsRow = db.prepare("SELECT value FROM settings WHERE key = 'kaspi_shops'").get();
  if (!kaspiShopsRow) {
    const defaultShops = [
      { name: "Магазин 1", token: "" },
      { name: "Магазин 2", token: "" },
      { name: "Магазин 3", token: "" }
    ];
    db.prepare("INSERT INTO settings (key, value) VALUES ('kaspi_shops', ?)").run(JSON.stringify(defaultShops));
  }

  const ensureMeta = (key, def) => {
    const row = db.prepare("SELECT value FROM meta WHERE key = ?").get(key);
    if (!row) db.prepare("INSERT INTO meta (key, value) VALUES (?, ?)").run(key, String(def));
  };
  ensureMeta("next_receipt_number", 1);
  ensureMeta("next_kaspi_number", 1);
  ensureMeta("version", "1.0.0");
}

export function ensureBootstrapUser() {
  const userCount = db.prepare("SELECT COUNT(*) as c FROM users").get().c;
  if (userCount === 0) {
    const bootstrapUser = process.env.ADMIN_USER || "admin";
    const bootstrapPass = process.env.ADMIN_PASS || "admin";
    db.prepare("INSERT INTO users (id, username, password_hash, role, created_at) VALUES (?, ?, ?, 'admin', ?)")
      .run("u_admin", bootstrapUser, bcrypt.hashSync(bootstrapPass, 10), new Date().toISOString());
    console.log(`[init] Создан пользователь по умолчанию: ${bootstrapUser} / ${bootstrapPass} (смените пароль после первого входа)`);
  }
}

export function initDb() {
  ensureSchema();
  ensureBootstrapUser();
}

export function getMeta(key) {
  const row = db.prepare("SELECT value FROM meta WHERE key = ?").get(key);
  return row ? row.value : null;
}
export function setMeta(key, value) {
  db.prepare("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
    .run(key, String(value));
}
export function nextReceiptNumber() {
  const n = parseInt(getMeta("next_receipt_number") || "1", 10);
  setMeta("next_receipt_number", n + 1);
  return n;
}
export function nextKaspiNumber() {
  const n = parseInt(getMeta("next_kaspi_number") || "1", 10);
  setMeta("next_kaspi_number", n + 1);
  return n;
}

export function getKaspiShops() {
  const row = db.prepare("SELECT value FROM settings WHERE key = 'kaspi_shops'").get();
  return row ? JSON.parse(row.value) : [];
}
export function setKaspiShops(shops) {
  db.prepare("INSERT INTO settings (key, value) VALUES ('kaspi_shops', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
    .run(JSON.stringify(shops));
}

export function logAudit({ user, action, orderId = null, oldValue = null, newValue = null, comment = null, ip = null }) {
  db.prepare(`INSERT INTO audit_log (user, action, order_id, old_value, new_value, comment, ip, created_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(
      user || "unknown", action, orderId,
      oldValue != null ? String(oldValue) : null,
      newValue != null ? String(newValue) : null,
      comment, ip, new Date().toISOString()
    );
}

// Одноразовый скрипт переноса данных из старого формата (lowdb, data.json)
// в новую БД SQLite. Нужен только если на сервере уже накопились реальные
// данные в data.json до перехода на v1.0.0.
//
// Использование (локально или через Shell на Render):
//   node migrate-json-to-sqlite.js /путь/к/старому/data.json
//
// Скрипт ничего не удаляет из старого файла — только читает и переносит.
// После успешного переноса старый data.json можно оставить как резервную копию.

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { db, ensureSchema, ensureBootstrapUser, setKaspiShops, setMeta } from "./db.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const jsonPath = process.argv[2] || path.join(__dirname, "data.json");

if (!fs.existsSync(jsonPath)) {
  console.error(`Файл не найден: ${jsonPath}`);
  console.error(`Укажите путь явно: node migrate-json-to-sqlite.js /data/data.json`);
  process.exit(1);
}

const old = JSON.parse(fs.readFileSync(jsonPath, "utf-8"));

ensureSchema(); // создаст таблицы, если их ещё нет (безопасно вызывать повторно) —
                 // БЕЗ создания дефолтного admin, чтобы не затереть реальный пароль

let migratedUsers = 0, migratedOrders = 0, migratedPrice = 0, migratedCategories = 0;

// ---------- Пользователи ----------
if (Array.isArray(old.users)) {
  for (const u of old.users) {
    const exists = db.prepare("SELECT id FROM users WHERE id = ? OR username = ?").get(u.id, u.username);
    if (exists) continue;
    db.prepare(`INSERT INTO users (id, username, password_hash, role, created_at) VALUES (?, ?, ?, ?, ?)`)
      .run(u.id, u.username, u.passwordHash, u.role || "admin", new Date().toISOString());
    migratedUsers++;
  }
}

// ---------- Заказы ----------
// В старом формате поле "status" было неоднозначным:
//  - для source='manual' это был статус "Прихода" (transit/arrived/problem)
//  - для source='kaspi' это был исходный статус от самого Kaspi
// В новой схеме это разведено на receive_status / kaspi_status,
// а "status" (внутренняя обработка) безопасно стартует с 'preorder' для всех.
if (Array.isArray(old.orders)) {
  for (const o of old.orders) {
    const exists = db.prepare("SELECT id FROM orders WHERE id = ?").get(o.id);
    if (exists) continue;
    const isManual = o.source !== "kaspi" && !o.kaspiOrderId;
    db.prepare(`INSERT INTO orders
      (id, source, kaspi_order_id, kaspi_code, shop, receipt_number, display_number,
       article, name, qty, note, photo, receive_status, status, kaspi_status, delivery_state,
       pre_order, assembled, courier_transmission_date, courier_handover_date, total_price,
       product_name, waybill_url, printed, claim_note, claim_resolved, raw, created_at, updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(
        o.id, isManual ? "manual" : "kaspi", o.kaspiOrderId || null, o.kaspiCode || null, o.shop || null,
        o.receiptNumber || null, o.displayNumber || null,
        o.article || "", o.name || "", o.qty || 0, o.note || "", o.photo || null,
        isManual ? (o.status || "transit") : "transit",
        "preorder", // новый внутренний статус обработки — стартуем с начала цепочки
        isManual ? null : (o.status || null),
        o.deliveryState || null,
        o.preOrder ? 1 : 0, o.assembled ? 1 : 0,
        o.courierTransmissionDate || null, o.courierHandoverDate || null, o.totalPrice || null,
        o.productName || null, o.waybillUrl || null, o.printed ? 1 : 0,
        o.claimNote || null, o.claimResolved ? 1 : 0,
        o.raw ? JSON.stringify(o.raw) : null,
        o.createdAt || new Date().toISOString(), new Date().toISOString()
      );
    migratedOrders++;
  }
}

// ---------- Прайс ----------
if (Array.isArray(old.priceItems)) {
  for (const p of old.priceItems) {
    const exists = db.prepare("SELECT id FROM price_items WHERE id = ?").get(p.id);
    if (exists) continue;
    db.prepare(`INSERT INTO price_items
      (id, article, name, type, color, height, diameter, weight, material, mount,
       buy_price_kzt, delivery_price, wholesale, retail, cost, note, photo, photo_name, created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(p.id, p.article || "", p.name || "", p.type || "", p.color || "",
           p.height || 0, p.diameter || 0, p.weight || 0, p.material || "", p.mount || "",
           p.buyPriceKzt || 0, p.deliveryPrice || 0, p.wholesale || 0, p.retail || 0,
           p.cost || 0, p.note || "", p.photo || null, p.photoName || "",
           p.createdAt || new Date().toISOString());
    migratedPrice++;
  }
}

// ---------- Категории ----------
if (Array.isArray(old.categories)) {
  for (const c of old.categories) {
    db.prepare("INSERT OR IGNORE INTO categories (name) VALUES (?)").run(c);
    migratedCategories++;
  }
}

// ---------- Настройки Kaspi и счётчики ----------
if (old.settings?.kaspi?.shops) {
  setKaspiShops(old.settings.kaspi.shops);
}
if (old.meta?.nextReceiptNumber) setMeta("next_receipt_number", old.meta.nextReceiptNumber);
if (old.meta?.nextKaspiNumber) setMeta("next_kaspi_number", old.meta.nextKaspiNumber);

// Если из старого файла не перенесли ни одного пользователя (например users
// отсутствовал в JSON) — создаём дефолтного admin, чтобы не остаться без входа
ensureBootstrapUser();

console.log("Готово. Перенесено:");
console.log(`  Пользователи: ${migratedUsers}`);
console.log(`  Заказы: ${migratedOrders}`);
console.log(`  Прайс: ${migratedPrice}`);
console.log(`  Категории: ${migratedCategories}`);
console.log("Старый файл не тронут — можно оставить как резервную копию.");

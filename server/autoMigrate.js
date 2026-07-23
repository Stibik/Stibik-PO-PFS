// Логика переноса данных из старого data.json — вынесена сюда, чтобы можно было
// вызвать автоматически при старте сервера (без доступа к Shell, которого нет
// на бесплатном тарифе Render).
import fs from "fs";
import { db, ensureBootstrapUser, setKaspiShops, setMeta } from "./db.js";

export function autoMigrateIfNeeded(jsonPath) {
  if (!jsonPath || !fs.existsSync(jsonPath)) return { ran: false };

  // Если в БД уже есть хоть один пользователь — считаем, что миграция (или
  // обычная работа) уже происходила, повторно ничего не переносим
  const userCount = db.prepare("SELECT COUNT(*) as c FROM users").get().c;
  if (userCount > 0) return { ran: false, reason: "users_already_exist" };

  console.log(`[auto-migrate] Найден старый data.json (${jsonPath}), переношу в SQLite...`);
  let old;
  try {
    old = JSON.parse(fs.readFileSync(jsonPath, "utf-8"));
  } catch (e) {
    console.log("[auto-migrate] Не удалось прочитать data.json:", e.message);
    return { ran: false, reason: "read_error" };
  }

  let migratedUsers = 0, migratedOrders = 0, migratedPrice = 0, migratedCategories = 0;

  if (Array.isArray(old.users)) {
    for (const u of old.users) {
      const exists = db.prepare("SELECT id FROM users WHERE id = ? OR username = ?").get(u.id, u.username);
      if (exists) continue;
      db.prepare(`INSERT INTO users (id, username, password_hash, role, created_at) VALUES (?, ?, ?, ?, ?)`)
        .run(u.id, u.username, u.passwordHash, u.role || "admin", new Date().toISOString());
      migratedUsers++;
    }
  }

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
          "preorder",
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

  if (Array.isArray(old.categories)) {
    for (const c of old.categories) {
      db.prepare("INSERT OR IGNORE INTO categories (name) VALUES (?)").run(c);
      migratedCategories++;
    }
  }

  if (old.settings?.kaspi?.shops) setKaspiShops(old.settings.kaspi.shops);
  if (old.meta?.nextReceiptNumber) setMeta("next_receipt_number", old.meta.nextReceiptNumber);
  if (old.meta?.nextKaspiNumber) setMeta("next_kaspi_number", old.meta.nextKaspiNumber);

  ensureBootstrapUser(); // если пользователей всё равно не нашлось — создаст admin/admin

  console.log(`[auto-migrate] Готово: пользователи ${migratedUsers}, заказы ${migratedOrders}, прайс ${migratedPrice}, категории ${migratedCategories}`);
  return { ran: true, migratedUsers, migratedOrders, migratedPrice, migratedCategories };
}

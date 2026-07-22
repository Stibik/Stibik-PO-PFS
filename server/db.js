import { Low } from "lowdb";
import { JSONFile } from "lowdb/node";
import bcrypt from "bcryptjs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = process.env.DB_PATH || path.join(__dirname, "data.json");

const defaultData = {
  users: [],
  orders: [],
  priceItems: [],
  categories: [],
  settings: {
    kaspi: {
      shops: [
        { name: "Магазин 1", token: "" },
        { name: "Магазин 2", token: "" },
        { name: "Магазин 3", token: "" }
      ]
    }
  },
  meta: { version: "0.4.0", nextReceiptNumber: 1, nextKaspiNumber: 1 }
};

const adapter = new JSONFile(DB_PATH);
export const db = new Low(adapter, defaultData);

export async function initDb() {
  await db.read();
  db.data ||= structuredClone(defaultData);
  db.data.users ||= [];
  db.data.orders ||= [];
  db.data.priceItems ||= [];
  db.data.categories ||= [];
  db.data.settings ||= structuredClone(defaultData.settings);
  db.data.settings.kaspi ||= structuredClone(defaultData.settings.kaspi);
  db.data.settings.kaspi.shops ||= structuredClone(defaultData.settings.kaspi.shops);
  db.data.meta ||= { version: "0.1.0" };
  db.data.meta.nextReceiptNumber ||= 1;
  db.data.meta.nextKaspiNumber ||= 1;

  if (db.data.users.length === 0) {
    const bootstrapUser = process.env.ADMIN_USER || "admin";
    const bootstrapPass = process.env.ADMIN_PASS || "admin";
    db.data.users.push({
      id: "u_admin",
      username: bootstrapUser,
      passwordHash: bcrypt.hashSync(bootstrapPass, 10),
      role: "admin"
    });
    await db.write();
    console.log(`[init] Создан пользователь по умолчанию: ${bootstrapUser} / ${bootstrapPass} (смените пароль после первого входа)`);
  }
  await db.write();
}

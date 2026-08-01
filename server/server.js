import "dotenv/config";

process.on("uncaughtException", (err) => {
  console.error("[fatal] uncaughtException:", err.message, err.stack);
  process.exit(1);
});
process.on("unhandledRejection", (err) => {
  console.error("[fatal] unhandledRejection:", err);
  process.exit(1);
});

import express from "express";
import session from "express-session";
import multer from "multer";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";

import { ensureSchema, ensureBootstrapUser } from "./db.js";
import { autoMigrateIfNeeded } from "./autoMigrate.js";
import authRoutes from "./routes/auth.js";
import orderRoutes from "./routes/orders.js";
import priceRoutes from "./routes/price.js";
import kaspiRoutes from "./routes/kaspi.js";
import catalogRoutes from "./routes/catalog.js";
import counterRoutes from "./routes/counters.js";
import employeeRoutes from "./routes/employees.js";
import companiesRoutes from "./routes/companies.js";
import pricePdfRoutes from "./routes/pricePdf.js";
import priceListsRoutes from "./routes/priceLists.js";
import chinaPurchasesRoutes from "./routes/chinaPurchases.js";
import chinaStockRoutes from "./routes/chinaStock.js";
import payrollRoutes from "./routes/payroll.js";
import tasksRoutes from "./routes/tasks.js";
import monitorRoutes from "./routes/monitor.js";
import dispatchRoutes from "./routes/dispatch.js";
import backupRoutes from "./routes/backup.js";
import productionRoutes from "./routes/production.js";
import metaRoutes from "./routes/meta.js";
import settingsRoutes from "./routes/settings.js";
import auditRoutes from "./routes/audit.js";
import { requireAuth, requirePermission } from "./middleware/auth.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const UPLOAD_DIR = process.env.UPLOAD_DIR || path.join(__dirname, "uploads");
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const app = express();
app.set("trust proxy", 1);

app.use(express.json({ limit: "5mb" }));

app.use(session({
  secret: process.env.SESSION_SECRET || "dev-secret-change-me",
  resave: false,
  saveUninitialized: false,
  cookie: {
    maxAge: 1000 * 60 * 60 * 24 * 7, // 7 дней
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax"
  }
}));

// Загрузка фото
const upload = multer({
  storage: multer.diskStorage({
    destination: UPLOAD_DIR,
    filename: (req, file, cb) => {
      const ext = path.extname(file.originalname) || ".jpg";
      cb(null, Date.now() + "_" + Math.random().toString(36).slice(2, 8) + ext);
    }
  }),
  limits: { fileSize: 8 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const okTypes = ["image/jpeg", "image/png", "image/webp", "image/gif"];
    if (!okTypes.includes(file.mimetype)) return cb(new Error("Разрешены только изображения (jpg/png/webp/gif)"));
    cb(null, true);
  }
});
app.post("/api/upload", requireAuth, (req, res) => {
  upload.single("photo")(req, res, (err) => {
    if (err) return res.status(400).json({ error: "upload_failed", message: err.message });
    if (!req.file) return res.status(400).json({ error: "no_file" });
    res.json({ path: "/uploads/" + req.file.filename });
  });
});
app.use("/uploads", express.static(UPLOAD_DIR));

// API маршруты
app.use("/api/auth", authRoutes);
app.use("/api/orders", orderRoutes);
app.use("/api/price", priceRoutes);
app.use("/api/kaspi", kaspiRoutes);
app.use("/api/catalog", catalogRoutes);
app.use("/api/counters", counterRoutes);
app.use("/api/employees", employeeRoutes);
app.use("/api/companies", companiesRoutes);
app.use("/api/price-pdf", requirePermission("price"), pricePdfRoutes);
app.use("/api/price-lists", requirePermission("price"), priceListsRoutes);
app.use("/api/china-purchases", requirePermission("china"), chinaPurchasesRoutes);
app.use("/api/china-stock", requirePermission("china"), chinaStockRoutes);
app.use("/api/payroll", requirePermission("salary"), payrollRoutes);
app.use("/api/tasks", tasksRoutes);
app.use("/api/monitor", monitorRoutes);
app.use("/api/dispatch", dispatchRoutes);
app.use("/api/backup", backupRoutes);
app.use("/api/production", productionRoutes);
app.use("/api/meta", metaRoutes);
app.use("/api/settings", requirePermission("kaspi"), settingsRoutes);
app.use("/api/audit", requirePermission("audit"), auditRoutes);

// Иконка приложения и манифест: чтобы во вкладке браузера был значок, а на
// телефоне «Добавить на главный экран» давало нормальную иконку и название
const APP_ICON = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">
  <rect width="512" height="512" rx="96" fill="#0F172A"/>
  <text x="50%" y="52%" text-anchor="middle" dominant-baseline="middle"
        font-family="Arial Black, Arial, sans-serif" font-size="190" font-weight="900" fill="#FFFFFF">PFS</text>
  <rect x="372" y="150" width="34" height="34" rx="8" fill="#F59E0B"/>
</svg>`;

app.get("/icon.svg", (req, res) => {
  res.setHeader("Content-Type", "image/svg+xml");
  res.setHeader("Cache-Control", "public, max-age=86400");
  res.send(APP_ICON);
});

app.get("/manifest.webmanifest", (req, res) => {
  res.setHeader("Content-Type", "application/manifest+json");
  res.json({
    name: "PFS Control — учёт заказов",
    short_name: "PFS Control",
    start_url: "/",
    display: "standalone",
    background_color: "#0F172A",
    theme_color: "#0F172A",
    icons: [
      { src: "/icon.svg", sizes: "any", type: "image/svg+xml", purpose: "any" },
      { src: "/icon.svg", sizes: "any", type: "image/svg+xml", purpose: "maskable" }
    ]
  });
});

// Service worker: без него Chrome не предлагает «Установить приложение».
// Стратегия намеренно простая — сеть в приоритете, кэш только как подстраховка,
// чтобы после обновления людям не показывалась старая версия программы.
app.get("/sw.js", (req, res) => {
  res.setHeader("Content-Type", "application/javascript");
  res.setHeader("Cache-Control", "no-cache");
  res.send(`
const CACHE = "pfs-shell-v1";
self.addEventListener("install", (e) => { self.skipWaiting(); });
self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))));
  self.clients.claim();
});
self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== location.origin) return;
  // Данные никогда не кэшируем: зарплата и заказы должны быть свежими
  if (url.pathname.startsWith("/api/")) return;
  event.respondWith(
    fetch(req).then(resp => {
      const copy = resp.clone();
      caches.open(CACHE).then(c => c.put(req, copy)).catch(()=>{});
      return resp;
    }).catch(() => caches.match(req))
  );
});
`);
});

// Статика фронтенда
app.use(express.static(path.join(__dirname, "public")));
app.get("/*splat", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

const PORT = process.env.PORT || 3000;

ensureSchema();

// Автоперенос старых данных (data.json -> SQLite), если найдём файл и БД ещё пустая.
// Работает без Shell — специально для бесплатного тарифа Render, где консоль недоступна.
const oldDataCandidates = [
  process.env.DB_PATH ? path.join(path.dirname(process.env.DB_PATH), "data.json") : null,
  path.join(__dirname, "data.json")
].filter(Boolean);
let migrated = false;
for (const candidate of oldDataCandidates) {
  const result = autoMigrateIfNeeded(candidate);
  if (result.ran) { migrated = true; break; }
}
ensureBootstrapUser(); // на случай, если старого data.json не нашлось — создаст admin/admin

// Сброс пароля админа без доступа к консоли — если задана переменная окружения
// RESET_ADMIN_PASSWORD, принудительно установим её как пароль пользователя
// ADMIN_USER (или 'admin', если не задан). После успешного входа переменную
// со сброшенным паролем стоит убрать из Environment на хостинге.
if (process.env.RESET_ADMIN_PASSWORD) {
  const bcrypt = (await import("bcryptjs")).default;
  const { db } = await import("./db.js");
  const username = process.env.ADMIN_USER || "admin";
  const hash = bcrypt.hashSync(process.env.RESET_ADMIN_PASSWORD, 10);
  const result = db.prepare("UPDATE users SET password_hash = ? WHERE username = ?").run(hash, username);
  if (result.changes > 0) {
    console.log(`[reset] Пароль пользователя "${username}" сброшен через RESET_ADMIN_PASSWORD`);
  } else {
    console.log(`[reset] Пользователь "${username}" не найден — пароль не сброшен`);
  }
}

app.listen(PORT, () => {
  console.log(`Сервер запущен: http://localhost:${PORT}`);
});

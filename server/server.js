import "dotenv/config";
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
import metaRoutes from "./routes/meta.js";
import settingsRoutes from "./routes/settings.js";
import auditRoutes from "./routes/audit.js";
import { requireAuth } from "./middleware/auth.js";

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
app.use("/api/meta", metaRoutes);
app.use("/api/settings", settingsRoutes);
app.use("/api/audit", auditRoutes);

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

app.listen(PORT, () => {
  console.log(`Сервер запущен: http://localhost:${PORT}`);
});

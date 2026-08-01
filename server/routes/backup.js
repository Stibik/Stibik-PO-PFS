import express from "express";
import fs from "fs";
import path from "path";
import zlib from "zlib";
import { fileURLToPath } from "url";
import { db, logAudit } from "../db.js";
import { requireAdmin } from "../middleware/auth.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = process.env.DB_PATH || path.join(__dirname, "..", "data.sqlite");
const UPLOAD_DIR = process.env.UPLOAD_DIR || path.join(__dirname, "..", "uploads");

const router = express.Router();
router.use(requireAdmin); // копия базы — это все данные компании, только администратор

function stamp() { return new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-"); }

// Что вообще внутри копии — чтобы перед скачиванием было видно, что не пусто
router.get("/info", (req, res) => {
  const count = (table) => {
    try { return db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n; } catch (e) { return 0; }
  };
  let dbSize = 0;
  try { dbSize = fs.statSync(DB_PATH).size; } catch (e) {}
  let photos = 0, photosSize = 0;
  try {
    for (const f of fs.readdirSync(UPLOAD_DIR)) {
      const st = fs.statSync(path.join(UPLOAD_DIR, f));
      if (st.isFile()) { photos++; photosSize += st.size; }
    }
  } catch (e) {}
  res.json({
    dbPath: DB_PATH, dbSize, uploadDir: UPLOAD_DIR, photos, photosSize,
    onPersistentDisk: DB_PATH.startsWith("/var/data"),
    counts: {
      orders: count("orders"), catalog: count("price_items"), companies: count("companies"),
      employees: count("employees"), payroll: count("payroll_entries"),
      chinaPurchases: count("china_purchase_orders"), users: count("users"), tasks: count("tasks")
    }
  });
});

// Копия базы. VACUUM INTO делает целостный снимок даже во время работы —
// простое копирование файла может поймать базу в середине записи.
router.get("/database", (req, res) => {
  const tmp = path.join("/tmp", `backup_${Date.now()}.sqlite`);
  try {
    try { fs.unlinkSync(tmp); } catch (e) {}
    db.prepare(`VACUUM INTO '${tmp.replace(/'/g, "''")}'`).run();
  } catch (e) {
    console.error("[backup] VACUUM INTO не сработал, копирую файл как есть:", e.message);
    try { fs.copyFileSync(DB_PATH, tmp); } catch (e2) {
      return res.status(500).json({ error: "backup_failed", message: "Не получилось сделать копию: " + e2.message });
    }
  }
  logAudit({ user: req.session.username, action: "backup_database" });
  res.setHeader("Content-Type", "application/octet-stream");
  res.setHeader("Content-Disposition", `attachment; filename="pfs-backup-${stamp()}.sqlite"`);
  const stream = fs.createReadStream(tmp);
  stream.pipe(res);
  stream.on("close", () => { try { fs.unlinkSync(tmp); } catch (e) {} });
});

// ---------- Архив с фотографиями ----------
// Собираем ZIP без сторонних библиотек: файлы кладём без сжатия (метод store).
// Фотографии — уже сжатые JPEG, повторное сжатие всё равно ничего не даст.
function crc32(buf) {
  let c, crc = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) {
    c = (crc ^ buf[i]) & 0xFF;
    for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0xEDB88320 : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

function buildZip(files) {
  const chunks = [], central = [];
  let offset = 0;
  for (const f of files) {
    const name = Buffer.from(f.name, "utf8");
    const crc = crc32(f.data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6); // имена файлов в UTF-8
    local.writeUInt16LE(0, 8);      // без сжатия
    local.writeUInt16LE(0, 10); local.writeUInt16LE(0, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(f.data.length, 18);
    local.writeUInt32LE(f.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    chunks.push(local, name, f.data);

    const cen = Buffer.alloc(46);
    cen.writeUInt32LE(0x02014b50, 0);
    cen.writeUInt16LE(20, 4); cen.writeUInt16LE(20, 6);
    cen.writeUInt16LE(0x0800, 8);
    cen.writeUInt16LE(0, 10);
    cen.writeUInt16LE(0, 12); cen.writeUInt16LE(0, 14);
    cen.writeUInt32LE(crc, 16);
    cen.writeUInt32LE(f.data.length, 20);
    cen.writeUInt32LE(f.data.length, 24);
    cen.writeUInt16LE(name.length, 28);
    cen.writeUInt32LE(offset, 42);
    central.push(cen, name);
    offset += local.length + name.length + f.data.length;
  }
  const centralBuf = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(centralBuf.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...chunks, centralBuf, end]);
}

router.get("/photos", (req, res) => {
  let names = [];
  try { names = fs.readdirSync(UPLOAD_DIR).filter(f => fs.statSync(path.join(UPLOAD_DIR, f)).isFile()); }
  catch (e) { return res.status(400).json({ error: "no_uploads", message: "Папка с фото не найдена: " + UPLOAD_DIR }); }
  if (!names.length) return res.status(400).json({ error: "empty", message: "Фотографий пока нет" });

  try {
    const files = names.map(n => ({ name: "uploads/" + n, data: fs.readFileSync(path.join(UPLOAD_DIR, n)) }));
    const zip = buildZip(files);
    logAudit({ user: req.session.username, action: "backup_photos", comment: `${files.length} файлов` });
    res.setHeader("Content-Type", "application/zip");
    res.setHeader("Content-Disposition", `attachment; filename="pfs-photos-${stamp()}.zip"`);
    res.send(zip);
  } catch (e) {
    res.status(500).json({ error: "zip_failed", message: "Не получилось собрать архив: " + e.message });
  }
});

export default router;

import express from "express";
import fs from "fs";
import path from "path";
import { createRequire } from "module";
const require = createRequire(import.meta.url);
import { fileURLToPath } from "url";
import { db, logAudit } from "../db.js";
import { requireAdmin } from "../middleware/auth.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = process.env.DB_PATH || path.join(__dirname, "..", "data.sqlite");
const UPLOAD_DIR = process.env.UPLOAD_DIR || path.join(__dirname, "..", "uploads");

// Постоянный диск определяем по тому, что путь лежит ВНЕ папки приложения.
// Раньше проверялся только /var/data, а Render разрешает любую точку
// монтирования — например /data, и программа зря пугала потерей данных.
function isPersistent(p) {
  const s = String(p || "");
  if (!s.startsWith("/")) return false;
  return !s.startsWith("/opt/render/project") && !s.startsWith(process.cwd()) && !s.startsWith("/tmp");
}

const router = express.Router();
router.use(requireAdmin); // копия базы — это все данные компании, только администратор

function str(v, max = 200) { return String(v == null ? "" : v).trim().slice(0, max); }
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
    onPersistentDisk: isPersistent(DB_PATH),
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

// ---------- Восстановление базы из копии ----------
// Самое опасное действие в системе: старая база заменяется целиком.
// Поэтому: только администратор, проверка, что файл настоящий, копия текущей
// базы в сторону и обязательный перезапуск сервиса после замены.
router.post("/restore", (req, res) => {
  const chunks = [];
  let size = 0;
  let aborted = false;

  req.on("data", (c) => {
    if (aborted) return;
    size += c.length;
    if (size > 300 * 1024 * 1024) { // 300 МБ с большим запасом
      aborted = true;
      res.status(400).json({ error: "too_big", message: "Файл больше 300 МБ — это не похоже на базу" });
      req.destroy();
      return;
    }
    chunks.push(c);
  });

  req.on("end", () => {
    if (aborted) return;
    const body = Buffer.concat(chunks);
    // Вырезаем содержимое файла из multipart-обёртки: ищем начало SQLite
    const marker = Buffer.from("SQLite format 3\u0000", "binary");
    const start = body.indexOf(marker);
    if (start === -1) {
      return res.status(400).json({ error: "not_sqlite", message: "Это не файл базы данных. Нужен файл, скачанный кнопкой «Скачать базу» (.sqlite)" });
    }
    // Хвост multipart после файла обрезаем по границе
    let end = body.length;
    const boundaryIdx = body.indexOf(Buffer.from("\r\n------"), start);
    if (boundaryIdx > start) end = boundaryIdx;
    const fileBuf = body.slice(start, end);

    const tmpPath = path.join("/tmp", `restore_${Date.now()}.sqlite`);
    try {
      fs.writeFileSync(tmpPath, fileBuf);
    } catch (e) {
      return res.status(500).json({ error: "write_failed", message: "Не получилось сохранить файл: " + e.message });
    }

    // Прежде чем что-то заменять — убеждаемся, что база открывается и в ней есть данные
    let stats = null;
    try {
      const { DatabaseSync } = require("node:sqlite");
      const check = new DatabaseSync(tmpPath, { readOnly: true });
      const orders = check.prepare("SELECT COUNT(*) AS n FROM orders").get().n;
      const items = check.prepare("SELECT COUNT(*) AS n FROM price_items").get().n;
      const users = check.prepare("SELECT COUNT(*) AS n FROM users").get().n;
      check.close();
      if (!users) throw new Error("в базе нет ни одного пользователя — войти будет нечем");
      stats = { orders, items, users };
    } catch (e) {
      try { fs.unlinkSync(tmpPath); } catch (e2) {}
      return res.status(400).json({ error: "bad_database", message: "Файл повреждён или это не база этой программы: " + e.message });
    }

    // В журнал пишем ДО замены файла: после неё открытая база указывает уже
    // на другой файл, и любая запись туда — непредсказуемое поведение
    try {
      logAudit({ user: req.session.username, action: "restore_database",
                 comment: `Заказов ${stats.orders}, товаров ${stats.items}` });
    } catch (e) { /* журнал не критичен, восстановление важнее */ }

    // Текущую базу не удаляем, а отодвигаем — если что-то пойдёт не так,
    // её можно будет вернуть через консоль
    try {
      if (fs.existsSync(DB_PATH)) {
        fs.copyFileSync(DB_PATH, DB_PATH + ".before-restore");
      }
      fs.copyFileSync(tmpPath, DB_PATH);
      // Журналы WAL от старой базы обязательно убираем: иначе поверх новой
      // базы применятся куски старой и данные перемешаются
      for (const suffix of ["-wal", "-shm"]) {
        try { fs.unlinkSync(DB_PATH + suffix); } catch (e) {}
      }
      fs.unlinkSync(tmpPath);
    } catch (e) {
      return res.status(500).json({ error: "replace_failed", message: "Не получилось заменить базу: " + e.message });
    }

    res.json({
      ok: true, ...stats,
      message: "База восстановлена. Сервис сейчас перезапустится — подождите полминуты и обновите страницу."
    });

    // Перезапуск обязателен: программа держит открытым старый файл базы
    console.log("[restore] База заменена, перезапускаю сервис");
    setTimeout(() => process.exit(0), 800);
  });
});

// ---------- Снимки перед опасными действиями ----------
// Копия базы кладётся рядом с ней на постоянный диск. Нужна, чтобы можно было
// откатиться, если массовая загрузка испортила данные.
const SNAP_DIR = path.join(path.dirname(DB_PATH), "snapshots");

export function makeSnapshot(reason) {
  try {
    fs.mkdirSync(SNAP_DIR, { recursive: true });
    const name = `${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-")}_${String(reason || "auto").replace(/[^a-zA-Zа-яА-Я0-9_-]/g, "")}.sqlite`;
    const full = path.join(SNAP_DIR, name);
    db.prepare(`VACUUM INTO '${full.replace(/'/g, "''")}'`).run();
    // Держим последние 20 снимков, старые удаляем — иначе диск заполнится
    const all = fs.readdirSync(SNAP_DIR).filter(f => f.endsWith(".sqlite")).sort();
    while (all.length > 20) {
      try { fs.unlinkSync(path.join(SNAP_DIR, all.shift())); } catch (e) {}
    }
    return name;
  } catch (e) {
    console.error("[snapshot] не удалось создать копию:", e.message);
    return null;
  }
}

router.get("/snapshots", (req, res) => {
  let list = [];
  try {
    list = fs.readdirSync(SNAP_DIR).filter(f => f.endsWith(".sqlite")).map(f => {
      const st = fs.statSync(path.join(SNAP_DIR, f));
      return { name: f, size: st.size, createdAt: st.mtime.toISOString() };
    }).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  } catch (e) {}
  res.json({ dir: SNAP_DIR, snapshots: list });
});

router.post("/snapshot", (req, res) => {
  const name = makeSnapshot(str(req.body?.reason, 40) || "ручная");
  if (!name) return res.status(500).json({ error: "snapshot_failed", message: "Не получилось создать копию" });
  res.json({ ok: true, name });
});

// Откат на снимок: перед откатом делаем ещё одну копию текущего состояния,
// чтобы «откат отката» тоже был возможен
router.post("/rollback", (req, res) => {
  const name = String(req.body?.name || "").replace(/[^a-zA-Zа-яА-Я0-9_.-]/g, "");
  const full = path.join(SNAP_DIR, name);
  if (!name || !fs.existsSync(full)) {
    return res.status(404).json({ error: "not_found", message: "Такой копии нет" });
  }
  try {
    const { DatabaseSync } = require("node:sqlite");
    const check = new DatabaseSync(full, { readOnly: true });
    const users = check.prepare("SELECT COUNT(*) AS n FROM users").get().n;
    check.close();
    if (!users) throw new Error("в копии нет пользователей");
  } catch (e) {
    return res.status(400).json({ error: "bad_snapshot", message: "Копия повреждена: " + e.message });
  }
  makeSnapshot("передОткатом");
  logAudit({ user: req.session.username, action: "rollback_snapshot", comment: name });
  try {
    fs.copyFileSync(full, DB_PATH);
    for (const suf of ["-wal", "-shm"]) { try { fs.unlinkSync(DB_PATH + suf); } catch (e) {} }
  } catch (e) {
    return res.status(500).json({ error: "rollback_failed", message: e.message });
  }
  res.json({ ok: true, message: "Откат выполнен, сервис перезапускается" });
  setTimeout(() => process.exit(0), 800);
});

export default router;

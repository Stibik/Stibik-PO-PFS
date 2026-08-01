import express from "express";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import PDFDocument from "pdfkit";
import { db } from "../db.js";
import { requireAuth } from "../middleware/auth.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FONT_REGULAR = path.join(__dirname, "..", "fonts", "DejaVuSans.ttf");
const FONT_BOLD = path.join(__dirname, "..", "fonts", "DejaVuSans-Bold.ttf");
const UPLOAD_DIR = process.env.UPLOAD_DIR || path.join(__dirname, "..", "uploads");

const router = express.Router();
router.use(requireAuth);

const PAGE_MARGIN = 40;
const PAGE_W = 595.28; // A4 pt (портрет)
const PAGE_H = 841.89;
const FOOTER_H = 40;                          // место под колонтитул внизу страницы
const CONTENT_BOTTOM = PAGE_H - PAGE_MARGIN - FOOTER_H;

// Колонки таблицы товаров. Ширины подобраны так, чтобы длинное название
// переносилось внутри своей колонки и не наезжало на характеристики и цену.
const COL = {
  photoX: PAGE_MARGIN,            photoW: 40,
  nameX:  PAGE_MARGIN + 50,       nameW: 195,
  specX:  PAGE_MARGIN + 255,      specW: 140,
  priceX: PAGE_W - PAGE_MARGIN - 120, priceW: 120
};

function fmtPrice(n) {
  if (n == null || n === "") return "";
  return Math.round(n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, " ") + " ₸";
}

// Путь вида "/uploads/xxx.jpg" → реальный файл на диске.
// Если путь внешний или файла нет — вернёт null, а не упадёт.
function resolveLocalUpload(webPath) {
  if (!webPath || typeof webPath !== "string") return null;
  if (!webPath.startsWith("/uploads/")) return null;
  const full = path.join(UPLOAD_DIR, webPath.slice("/uploads/".length));
  return fs.existsSync(full) ? full : null;
}

// Группировка по ТЗ: Категория → Диаметр → Материал → Высота → Название.
// Категория и диаметр склеены в один заголовок группы («ГРУШИ · Ø 35 СМ»),
// материал выводится отдельной плашкой внутри группы.
function groupItems(items) {
  const byCategory = new Map();
  for (const it of items) {
    const cat = it.category || "Без категории";
    if (!byCategory.has(cat)) byCategory.set(cat, []);
    byCategory.get(cat).push(it);
  }
  const result = [];
  for (const [cat, catItems] of byCategory) {
    const byDiameter = new Map();
    for (const it of catItems) {
      const dKey = it.diameter ? `Ø ${it.diameter} см` : "__nodiam__";
      if (!byDiameter.has(dKey)) byDiameter.set(dKey, []);
      byDiameter.get(dKey).push(it);
    }
    for (const [dKey, dItems] of byDiameter) {
      const byMaterial = new Map();
      for (const it of dItems) {
        const mKey = it.material || "__nomat__";
        if (!byMaterial.has(mKey)) byMaterial.set(mKey, []);
        byMaterial.get(mKey).push(it);
      }
      for (const [mKey, mItems] of byMaterial) {
        mItems.sort((a, b) =>
          (a.sortOrder || 0) - (b.sortOrder || 0) ||
          (Number(a.height) || 0) - (Number(b.height) || 0) ||
          (a.printName || "").localeCompare(b.printName || "", "ru"));
        result.push({
          title: dKey === "__nodiam__" ? cat.toUpperCase() : `${cat.toUpperCase()} · ${dKey.toUpperCase()}`,
          material: mKey === "__nomat__" ? null : mKey,
          items: mItems
        });
      }
    }
  }
  return result;
}

// Основная сборка документа — используется и для скачивания, и для предпросмотра,
// чтобы они гарантированно не расходились (требование ТЗ).
function buildPdfDocument({ company, items, settings, priceName }) {
  const doc = new PDFDocument({ size: "A4", margin: PAGE_MARGIN, bufferPages: true });
  doc.registerFont("F", FONT_REGULAR);
  doc.registerFont("FB", FONT_BOLD);
  doc.font("F");

  const rowH = 50;
  const groupHeaderH = 40;

  // Шапка таблицы повторяется на каждой новой странице (требование ТЗ 7.2)
  function drawTableHeader() {
    const y = doc.y;
    doc.fontSize(7.5).fillColor("#6B7280").font("FB");
    if (settings.showPhoto) doc.text("ФОТО", COL.photoX, y, { width: COL.photoW });
    doc.text("МОДЕЛЬ", COL.nameX, y, { width: COL.nameW });
    doc.text("ХАРАКТЕРИСТИКИ", COL.specX, y, { width: COL.specW });
    doc.text("ЦЕНА", COL.priceX, y, { width: COL.priceW, align: "right" });
    doc.font("F");
    doc.y = y + 11;
    doc.moveTo(PAGE_MARGIN, doc.y).lineTo(PAGE_W - PAGE_MARGIN, doc.y).lineWidth(0.8).strokeColor("#CBD5E1").stroke();
    doc.y += 8;
  }

  function newPage() {
    doc.addPage();
    doc.y = PAGE_MARGIN;
    drawTableHeader();
  }

  // Заголовок группы не должен остаться внизу страницы один: для него требуем
  // место сразу и под сам заголовок, и хотя бы под одну строку товара.
  function ensureSpace(neededHeight, isGroupStart) {
    const minNeeded = isGroupStart ? neededHeight + rowH : neededHeight;
    if (doc.y + minNeeded > CONTENT_BOTTOM) newPage();
  }

  // ---------- Шапка документа ----------
  const logoPath = resolveLocalUpload(company.logo);
  if (logoPath) {
    try { doc.image(logoPath, PAGE_MARGIN, PAGE_MARGIN, { fit: [90, 46] }); } catch (e) {}
  }
  doc.fontSize(9).fillColor("#6B7280")
     .text(`Сформировано: ${new Date().toLocaleDateString("ru-RU")}`, PAGE_MARGIN, PAGE_MARGIN, { align: "right", width: PAGE_W - 2 * PAGE_MARGIN })
     .text("Цены указаны в тенге", { align: "right", width: PAGE_W - 2 * PAGE_MARGIN });

  doc.y = PAGE_MARGIN + 50;
  doc.fontSize(24).fillColor("#172554").font("FB").text("ПРАЙС-ЛИСТ", PAGE_MARGIN, doc.y);
  doc.font("F");
  if (priceName) {
    doc.fontSize(13).fillColor("#374151").text(priceName, PAGE_MARGIN, doc.y + 2, { width: PAGE_W - 2 * PAGE_MARGIN });
  }

  if (settings.showRequisites) {
    doc.moveDown(0.5);
    doc.fontSize(9.5).fillColor("#374151");
    const reqLines = [
      company.fullName,
      company.bin ? `БИН/ИИН: ${company.bin}` : null,
      company.address,
      [company.bankName, company.bik ? `БИК ${company.bik}` : null].filter(Boolean).join(", ") || null,
      company.iban ? `IBAN: ${company.iban}` : null,
      company.kbe ? `КБе: ${company.kbe}` : null,
      [company.phone, company.email, company.website].filter(Boolean).join(" · ") || null
    ].filter(Boolean);
    reqLines.forEach(line => doc.text(line, PAGE_MARGIN, doc.y, { width: PAGE_W - 2 * PAGE_MARGIN }));
    if (settings.showExtraText && company.extraText) {
      doc.moveDown(0.3).fontSize(9).fillColor("#6B7280").text(company.extraText, PAGE_MARGIN, doc.y, { width: PAGE_W - 2 * PAGE_MARGIN });
    }
  }

  doc.moveDown(0.8);
  doc.moveTo(PAGE_MARGIN, doc.y).lineTo(PAGE_W - PAGE_MARGIN, doc.y).lineWidth(2).strokeColor("#172554").stroke();
  doc.y += 14;

  drawTableHeader();

  // ---------- Товары ----------
  for (const group of groupItems(items)) {
    ensureSpace(groupHeaderH, true);
    doc.fontSize(12).fillColor("#172554").font("FB").text(group.title, PAGE_MARGIN, doc.y, { width: PAGE_W - 2 * PAGE_MARGIN });
    doc.font("F");
    doc.y += 4;

    if (group.material) {
      const badgeY = doc.y;
      const badgeW = Math.max(46, doc.widthOfString(group.material) + 16);
      doc.roundedRect(PAGE_MARGIN, badgeY, badgeW, 16, 4).fillAndStroke("#FEF3C7", "#F59E0B");
      doc.fontSize(9).fillColor("#92400E").text(group.material, PAGE_MARGIN, badgeY + 4, { width: badgeW, align: "center" });
      doc.y = badgeY + 22;
    }

    for (const it of group.items) {
      ensureSpace(rowH, false);
      const rowTop = doc.y;

      if (settings.showPhoto) {
        const photoPath = resolveLocalUpload(it.photo);
        // fit сохраняет пропорции — фото не растягивается (требование ТЗ 3)
        if (photoPath) { try { doc.image(photoPath, COL.photoX, rowTop, { fit: [COL.photoW, 44] }); } catch (e) {} }
      }

      doc.fontSize(11).fillColor("#0F172A").font("FB")
         .text(it.printName || "—", COL.nameX, rowTop, { width: COL.nameW });
      const afterName = doc.y;
      if (settings.showArticle && it.article) {
        doc.font("F").fontSize(8.5).fillColor("#6B7280")
           .text(`Арт. ${it.article}`, COL.nameX, afterName + 1, { width: COL.nameW });
      }

      const bits = [];
      if (settings.showMaterial && it.material) bits.push(it.material);
      if (settings.showSizes && it.height) bits.push(`Высота ${it.height} см`);
      if (settings.showWeight && it.weight) bits.push(`Вес ${it.weight} кг`);
      doc.font("F").fontSize(9).fillColor("#475569")
         .text(bits.length ? bits.join(" · ") : "—", COL.specX, rowTop + 3, { width: COL.specW });

      doc.fontSize(14).fillColor("#0F172A").font("FB")
         .text(fmtPrice(it.retailPrice) || "—", COL.priceX, rowTop + 2, { width: COL.priceW, align: "right" });
      doc.font("F");

      // Низ строки — по самой длинной из колонок, чтобы ничего не наложилось
      doc.y = Math.max(doc.y, rowTop + (settings.showPhoto ? 46 : 34));
      doc.moveTo(PAGE_MARGIN, doc.y + 4).lineTo(PAGE_W - PAGE_MARGIN, doc.y + 4).lineWidth(0.5).strokeColor("#E5E7EB").stroke();
      doc.y += 12;
    }
    doc.y += 6;
  }

  // ---------- Колонтитулы ----------
  const pageCount = doc.bufferedPageRange().count;
  for (let i = 0; i < pageCount; i++) {
    doc.switchToPage(i);
    const footY = PAGE_H - PAGE_MARGIN - 24;
    doc.moveTo(PAGE_MARGIN, footY - 8).lineTo(PAGE_W - PAGE_MARGIN, footY - 8).lineWidth(0.8).strokeColor("#172554").stroke();
    doc.font("F").fontSize(8).fillColor("#6B7280")
       .text("В прайс включены только выбранные товары", PAGE_MARGIN, footY, { width: PAGE_W - 2 * PAGE_MARGIN - 120 });
    doc.fontSize(8).fillColor("#9CA3AF")
       .text(`Страница ${i + 1} из ${pageCount}`, PAGE_W - PAGE_MARGIN - 120, footY, { width: 120, align: "right" });
    if (i === pageCount - 1) {
      doc.fontSize(7.5).fillColor("#9CA3AF")
         .text("Характеристики и цены сформированы автоматически из справочника", PAGE_MARGIN, footY + 11, { width: PAGE_W - 2 * PAGE_MARGIN - 120 });
    }
  }

  return doc;
}

function transliterate(s) {
  const map = { а:"a",б:"b",в:"v",г:"g",д:"d",е:"e",ё:"e",ж:"zh",з:"z",и:"i",й:"y",к:"k",л:"l",м:"m",н:"n",о:"o",п:"p",р:"r",с:"s",т:"t",у:"u",ф:"f",х:"h",ц:"ts",ч:"ch",ш:"sh",щ:"sch",ъ:"",ы:"y",ь:"",э:"e",ю:"yu",я:"ya" };
  return String(s).toLowerCase().split("").map(ch => map[ch] ?? ch).join("").replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
}

// Имя файла для заголовка Content-Disposition.
// ВАЖНО: в сам заголовок нельзя класть кириллицу — Node роняет ответ с
// ERR_INVALID_CHAR (проверено). Поэтому: латиницей — в filename (запасной
// вариант), кириллицей — в filename* по RFC 5987 (percent-encoding, ASCII).
// Современные браузеры возьмут второе и сохранят файл с русским названием.
function contentDisposition(companyShortName) {
  const date = new Date().toISOString().slice(0, 10);
  const asciiName = `Price_${transliterate(companyShortName || "company") || "company"}_${date}.pdf`;
  const utf8Name = encodeURIComponent(`Прайс_${companyShortName || ""}_${date}.pdf`.replace(/\s+/g, " ").trim());
  return `attachment; filename="${asciiName}"; filename*=UTF-8''${utf8Name}`;
}

// Общая подготовка данных из БД по списку id — используется и для скачивания,
// и для предпросмотра, чтобы они гарантированно не расходились
function loadPdfInputs(body) {
  const company = db.prepare("SELECT * FROM companies WHERE id = ?").get(body.companyId);
  if (!company) return { error: "company_not_found" };
  const ids = Array.isArray(body.itemIds) ? body.itemIds : [];
  if (!ids.length) return { error: "no_items" };
  const placeholders = ids.map(() => "?").join(",");
  const rows = db.prepare(`SELECT * FROM price_items WHERE id IN (${placeholders})`).all(...ids);

  const items = rows.map(row => ({
    printName: row.name, article: row.article, category: row.type, subgroup: row.subgroup,
    material: row.material, height: row.height, diameter: row.diameter, weight: row.weight,
    retailPrice: row.retail, photo: row.photo, sortOrder: row.sort_order || 0
  }));

  const settings = Object.assign({
    showPhoto: true, showArticle: true, showMaterial: true, showSizes: true,
    showWeight: true, showRequisites: true, showExtraText: true, onlyWithPrice: true
  }, body.settings || {});

  let finalItems = items;
  if (settings.onlyWithPrice) finalItems = finalItems.filter(it => it.retailPrice != null && it.retailPrice !== "");

  const companyObj = {
    shortName: company.short_name, fullName: company.full_name, bin: company.bin, address: company.address,
    bankName: company.bank_name, bik: company.bik, iban: company.iban, kbe: company.kbe,
    phone: company.phone, email: company.email, website: company.website, logo: company.logo,
    extraText: company.extra_text
  };

  // Название прайса — свободный текст от пользователя, режем длину и убираем
  // переводы строк, чтобы не поехала вёрстка шапки
  const priceName = String(body.priceName || "").replace(/[\r\n\t]+/g, " ").trim().slice(0, 120);

  return { company: companyObj, items: finalItems, settings, priceName };
}

function sendPdf(req, res, mode) {
  const inputs = loadPdfInputs(req.body || {});
  if (inputs.error === "company_not_found") return res.status(400).json({ error: "company_not_found", message: "Компания не найдена" });
  if (inputs.error === "no_items") return res.status(400).json({ error: "no_items", message: "Не выбрано ни одного товара" });
  if (!inputs.items.length) return res.status(400).json({ error: "no_items", message: "После настройки «только товары с ценой» не осталось ни одного товара" });

  try {
    const doc = buildPdfDocument(inputs);
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", mode === "preview" ? "inline" : contentDisposition(inputs.company.shortName));
    doc.pipe(res);
    doc.end();
  } catch (e) {
    console.error(`[price-pdf:${mode}] Ошибка генерации:`, e);
    res.status(500).json({ error: "pdf_generation_failed", message: "Не получилось собрать PDF: " + e.message });
  }
}

// Скачивание готового PDF-файла
router.post("/generate-pdf", (req, res) => sendPdf(req, res, "download"));

// Предпросмотр — тот же самый документ, но отдаётся inline (открывается в
// браузере, не скачивается) — по требованию ТЗ «предпросмотр = точная копия PDF»
router.post("/preview-pdf", (req, res) => sendPdf(req, res, "preview"));

export default router;

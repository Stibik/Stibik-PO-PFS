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
const CONTENT_BOTTOM = PAGE_H - PAGE_MARGIN - 30;

function fmtPrice(n) {
  if (n == null || n === "") return "";
  return Math.round(n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, " ") + " ₸";
}

// Путь вида "/uploads/xxx.jpg" → реальный файл на диске.
// Если путь уже абсолютный (внешний URL) или файла нет — вернёт null, а не упадёт.
function resolveLocalUpload(webPath) {
  if (!webPath || typeof webPath !== "string") return null;
  if (!webPath.startsWith("/uploads/")) return null;
  const full = path.join(UPLOAD_DIR, webPath.slice("/uploads/".length));
  return fs.existsSync(full) ? full : null;
}

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
    const diamGroups = [];
    for (const [dKey, dItems] of byDiameter) {
      const byMaterial = new Map();
      for (const it of dItems) {
        const mKey = it.material || "__nomat__";
        if (!byMaterial.has(mKey)) byMaterial.set(mKey, []);
        byMaterial.get(mKey).push(it);
      }
      const matGroups = [];
      for (const [mKey, mItems] of byMaterial) {
        mItems.sort((a, b) => (a.sortOrder || 0) - (b.sortOrder || 0) || (a.printName || "").localeCompare(b.printName || ""));
        matGroups.push({ material: mKey === "__nomat__" ? null : mKey, items: mItems });
      }
      diamGroups.push({ diameter: dKey === "__nodiam__" ? null : dKey, materials: matGroups });
    }
    result.push({ category: cat, diameters: diamGroups });
  }
  return result;
}

// Основная сборка документа — используется и для скачивания, и для предпросмотра,
// чтобы они гарантированно не расходились (требование ТЗ).
function buildPdfDocument({ company, items, settings }) {
  const doc = new PDFDocument({ size: "A4", margin: PAGE_MARGIN, bufferPages: true });
  doc.registerFont("F", FONT_REGULAR);
  doc.registerFont("FB", FONT_BOLD);
  doc.font("F");

  const rowH = 54;
  const groupHeaderH = 26;
  const subHeaderH = 20;

  function ensureSpace(neededHeight, isGroupStart) {
    const minNeeded = isGroupStart ? neededHeight + rowH : neededHeight;
    if (doc.y + minNeeded > CONTENT_BOTTOM) doc.addPage();
  }

  const logoPath = resolveLocalUpload(company.logo);
  if (logoPath) {
    try { doc.image(logoPath, PAGE_MARGIN, PAGE_MARGIN, { fit: [90, 50] }); } catch (e) {}
  }
  doc.fontSize(9).fillColor("#6B7280")
     .text(`Сформировано: ${new Date().toLocaleDateString("ru-RU")}`, PAGE_MARGIN, PAGE_MARGIN, { align: "right", width: PAGE_W - 2 * PAGE_MARGIN })
     .text("Цены указаны в тенге", { align: "right", width: PAGE_W - 2 * PAGE_MARGIN });

  doc.moveDown(2);
  doc.fontSize(22).fillColor("#172554").font("FB").text("ПРАЙС-ЛИСТ", PAGE_MARGIN);
  doc.font("F");

  if (settings.showRequisites) {
    doc.moveDown(0.3);
    doc.fontSize(10).fillColor("#374151");
    const reqLines = [
      company.fullName,
      company.bin ? `БИН/ИИН: ${company.bin}` : null,
      company.address,
      [company.bankName, company.bik ? `БИК ${company.bik}` : null].filter(Boolean).join(", ") || null,
      company.iban ? `IBAN: ${company.iban}` : null,
      company.kbe ? `КБе: ${company.kbe}` : null,
      [company.phone, company.email, company.website].filter(Boolean).join(" · ") || null
    ].filter(Boolean);
    reqLines.forEach(line => doc.text(line, { width: PAGE_W - 2 * PAGE_MARGIN }));
    if (settings.showExtraText && company.extraText) {
      doc.moveDown(0.3).fontSize(9).fillColor("#6B7280").text(company.extraText, { width: PAGE_W - 2 * PAGE_MARGIN });
    }
  }

  doc.moveDown(0.8);
  doc.moveTo(PAGE_MARGIN, doc.y).lineTo(PAGE_W - PAGE_MARGIN, doc.y).lineWidth(2).strokeColor("#172554").stroke();
  doc.moveDown(0.6);

  const groups = groupItems(items);
  for (const catGroup of groups) {
    ensureSpace(groupHeaderH, true);
    doc.fontSize(13).fillColor("#172554").font("FB").text(catGroup.category.toUpperCase(), PAGE_MARGIN);
    doc.font("F");
    doc.moveDown(0.3);

    for (const diamGroup of catGroup.diameters) {
      if (diamGroup.diameter) {
        ensureSpace(subHeaderH, true);
        doc.fontSize(11).fillColor("#374151").font("FB").text(diamGroup.diameter, PAGE_MARGIN);
        doc.font("F");
        doc.moveDown(0.2);
      }
      for (const matGroup of diamGroup.materials) {
        if (matGroup.material) {
          ensureSpace(subHeaderH, true);
          const badgeY = doc.y;
          doc.roundedRect(PAGE_MARGIN, badgeY, 70, 16, 3).fillAndStroke("#FEF3C7", "#F59E0B");
          doc.fontSize(9).fillColor("#92400E").text(matGroup.material, PAGE_MARGIN, badgeY + 4, { width: 70, align: "center" });
          doc.y = badgeY + 16 + 6;
        }
        for (const it of matGroup.items) {
          ensureSpace(rowH, false);
          const rowTop = doc.y;
          if (settings.showPhoto) {
            const photoPath = resolveLocalUpload(it.photo);
            if (photoPath) { try { doc.image(photoPath, PAGE_MARGIN, rowTop, { fit: [40, 40] }); } catch (e) {} }
          }
          const textX = PAGE_MARGIN + 50;
          const textW = PAGE_W - 2 * PAGE_MARGIN - 50 - 110;
          doc.fontSize(11).fillColor("#0F172A").font("FB").text(it.printName || "—", textX, rowTop, { width: textW });
          doc.font("F").fontSize(8.5).fillColor("#6B7280");
          const bits = [];
          if (settings.showArticle && it.article) bits.push(`Арт. ${it.article}`);
          if (settings.showMaterial && it.material) bits.push(it.material);
          if (settings.showSizes && it.height) bits.push(`Высота ${it.height} см`);
          if (settings.showWeight && it.weight) bits.push(`Вес ${it.weight} кг`);
          if (bits.length) doc.text(bits.join(" · "), textX, doc.y, { width: textW });

          doc.fontSize(14).fillColor("#0F172A").font("FB")
             .text(fmtPrice(it.retailPrice), PAGE_MARGIN + PAGE_W - 2 * PAGE_MARGIN - 110, rowTop + 8, { width: 110, align: "right" });
          doc.font("F");

          const newY = Math.max(doc.y, rowTop + 44);
          doc.y = newY;
          doc.moveTo(PAGE_MARGIN, doc.y + 4).lineTo(PAGE_W - PAGE_MARGIN, doc.y + 4).lineWidth(0.5).strokeColor("#E5E7EB").stroke();
          doc.y += 10;
        }
      }
    }
    doc.moveDown(0.4);
  }

  const pageCount = doc.bufferedPageRange().count;
  for (let i = 0; i < pageCount; i++) {
    doc.switchToPage(i);
    doc.fontSize(8).fillColor("#9CA3AF")
       .text(`Страница ${i + 1} из ${pageCount}`, PAGE_MARGIN, PAGE_H - PAGE_MARGIN - 10, { width: PAGE_W - 2 * PAGE_MARGIN, align: "center" });
    if (i === pageCount - 1) {
      doc.fontSize(7.5).fillColor("#9CA3AF")
         .text("Характеристики и цены сформированы автоматически из справочника", PAGE_MARGIN, PAGE_H - PAGE_MARGIN - 22, { width: PAGE_W - 2 * PAGE_MARGIN, align: "center" });
    }
  }

  return doc;
}

function transliterate(s) {
  const map = { а:"a",б:"b",в:"v",г:"g",д:"d",е:"e",ё:"e",ж:"zh",з:"z",и:"i",й:"y",к:"k",л:"l",м:"m",н:"n",о:"o",п:"p",р:"r",с:"s",т:"t",у:"u",ф:"f",х:"h",ц:"ts",ч:"ch",ш:"sh",щ:"sch",ъ:"",ы:"y",ь:"",э:"e",ю:"yu",я:"ya" };
  return String(s).toLowerCase().split("").map(ch => map[ch] ?? ch).join("").replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
}

// Общая подготовка данных из БД по списку id — используется и для скачивания,
// и для предпросмотра, чтобы гарантированно не расходились
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
  return { company: companyObj, items: finalItems, settings };
}

// Скачивание готового PDF-файла
router.post("/generate-pdf", (req, res) => {
  const inputs = loadPdfInputs(req.body || {});
  if (inputs.error === "company_not_found") return res.status(400).json({ error: "company_not_found", message: "Компания не найдена" });
  if (inputs.error === "no_items") return res.status(400).json({ error: "no_items", message: "Не выбрано ни одного товара" });

  try {
    const doc = buildPdfDocument(inputs);
    const filename = `Прайс_${transliterate(inputs.company.shortName || "company")}_${new Date().toISOString().slice(0, 10)}.pdf`;
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    doc.pipe(res);
    doc.end();
  } catch (e) {
    console.error("[price-pdf] Ошибка генерации:", e);
    res.status(500).json({ error: "pdf_generation_failed", message: "Не получилось собрать PDF: " + e.message });
  }
});

// Предпросмотр — тот же самый документ, но отдаётся inline (открывается в
// браузере, не скачивается) — по требованию ТЗ "предпросмотр = точная копия PDF"
router.post("/preview-pdf", (req, res) => {
  const inputs = loadPdfInputs(req.body || {});
  if (inputs.error === "company_not_found") return res.status(400).json({ error: "company_not_found", message: "Компания не найдена" });
  if (inputs.error === "no_items") return res.status(400).json({ error: "no_items", message: "Не выбрано ни одного товара" });

  try {
    const doc = buildPdfDocument(inputs);
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", "inline");
    doc.pipe(res);
    doc.end();
  } catch (e) {
    console.error("[price-pdf-preview] Ошибка генерации:", e);
    res.status(500).json({ error: "pdf_generation_failed", message: "Не получилось собрать предпросмотр: " + e.message });
  }
});

export default router;

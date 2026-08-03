import express from "express";
import { db, logAudit, bumpOrderNumber } from "../db.js";
import { requireAuth, requireAdmin } from "../middleware/auth.js";

const router = express.Router();
router.use(requireAuth);
router.use(requireAdmin); // перенос трогает деньги и номера заказов — только админ

function uid(prefix) { return prefix + "_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }
function num(v) { const n = Number(v); return Number.isFinite(n) ? n : 0; }
function str(v, max = 300) { return String(v == null ? "" : v).replace(/[\r\n\t]+/g, " ").trim().slice(0, max); }

// Слова, которые в колонке «Исполнитель» означают не человека, а пометку.
// «Перекрыто» и «Без оплаты» — это заказ, закрытый товаром с возврата или
// отмены: работу заново не делали, платить не за что.
const NOT_A_PERSON = new Set([
  "перекрыто","перекрыт","перекрытро","прекрыт","возврат","отмена","пропустим",
  "без оплаты","хз","","none","-","—"
]);
const COVERED_WORDS = ["перекрыт","прекрыт","возврат","отмена","без оплаты","пропустим"];
// «Доплатить» — это НЕ перекрытие, а прямое указание, что человеку должны
const DEBT_WORDS = ["доплатить","долг","не выплачено"];

// Заказ закрыт со склада (возврат/отмена), а не изготовлен заново
function isCovered(raw) {
  const ex = String(raw.executor || "").toLowerCase().trim();
  const pay = String(raw.payCode || "").toLowerCase().trim();
  if (COVERED_WORDS.some(w => ex.includes(w))) return true;
  if (DEBT_WORDS.some(w => pay.includes(w))) return false;   // «доплатить» — это долг, а не перекрытие
  if (COVERED_WORDS.some(w => pay.includes(w))) return true; // «без оплаты», «отмена», «пропустим»
  return false;
}
// В старом файле имена писали по-разному
const NAME_FIX = { "агдрей": "Андрей", "илья": "Илья", "нурбол": "Нурбол", "андрей": "Андрей", "бекзат": "Бекзат", "слава": "Слава" };

function cleanName(v) {
  const s = str(v, 60);
  const low = s.toLowerCase();
  if (NOT_A_PERSON.has(low)) return null;
  return NAME_FIX[low] || s;
}

// Отметка об оплате. В новом формате это дата выплаты, в старом — код вида
// «Б1906» (буква имени плюс день и месяц). Понимаем оба варианта.
function payCodeOf(v) {
  if (!v) return null;
  // Дата: пришла как ISO-строка от браузера
  const s = String(v).trim();
  const iso = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (iso) return { date: `${iso[1]}-${iso[2]}-${iso[3]}`, label: `${iso[3]}.${iso[2]}.${iso[1]}` };
  // Дата в привычном виде 19.01.2026 или 19.01
  const dot = s.match(/^(\d{1,2})[.\/](\d{1,2})(?:[.\/](\d{2,4}))?$/);
  if (dot) {
    const year = dot[3] ? (dot[3].length === 2 ? "20" + dot[3] : dot[3]) : String(new Date().getFullYear());
    return { date: `${year}-${dot[2].padStart(2, "0")}-${dot[1].padStart(2, "0")}`, label: s };
  }
  // Старый код «Н1901» — день и месяц без года
  const code = s.match(/^([АABНHИСБб])\s?(\d{2})(\d{2})$/i);
  if (code) {
    const year = new Date().getFullYear();
    return { date: `${year}-${code[3]}-${code[2]}`, label: s.toUpperCase().replace(/\s/g, "") };
  }
  return null;
}

function analyze(rows) {
  const employees = new Map();
  let matched = 0, notMatched = 0, withRate = 0, paidSum = 0, debtSum = 0, numbered = 0, covered = 0;
  let noExecutor = 0;   // пустая клетка «Исполнитель» — это то, что придётся разносить руками
  const unmatchedExamples = [];

  for (const raw of rows) {
    const kaspiCode = str(raw.kaspiCode, 40);
    const n = num(raw.num);
    if (kaspiCode && n > 0) {
      const order = db.prepare("SELECT id, display_number FROM orders WHERE kaspi_code = ?").get(kaspiCode);
      if (order) { matched++; if (order.display_number !== n) numbered++; }
      else { notMatched++; if (unmatchedExamples.length < 5) unmatchedExamples.push(`${n} / ${kaspiCode}`); }
    }
    if (isCovered(raw)) { covered++; continue; }
    const name = cleanName(raw.executor);
    const amount = num(raw.amount);
    if (!name) { noExecutor++; continue; }
    if (!employees.has(name)) employees.set(name, { works: 0, paid: 0, debt: 0 });
    const e = employees.get(name);
    e.works++;
    if (amount > 0) {
      withRate++;
      if (payCodeOf(raw.payCode)) { e.paid += amount; paidSum += amount; }
      else { e.debt += amount; debtSum += amount; }
    }
  }
  return {
    rows: rows.length, matched, notMatched, numbered, withRate, covered, noExecutor,
    paidSum: Math.round(paidSum), debtSum: Math.round(debtSum),
    unmatchedExamples,
    employees: Array.from(employees.entries()).map(([name, v]) => ({
      name, works: v.works, paid: Math.round(v.paid), debt: Math.round(v.debt),
      exists: !!db.prepare("SELECT id FROM employees WHERE lower(name) = lower(?)").get(name)
    })).sort((a, b) => b.debt - a.debt)
  };
}

// Предпросмотр: ничего не меняем, только показываем, что получится
router.post("/preview", (req, res) => {
  const rows = Array.isArray(req.body?.rows) ? req.body.rows : [];
  if (!rows.length) return res.status(400).json({ error: "no_rows", message: "В файле не нашлось строк" });
  res.json(analyze(rows));
});

router.post("/apply", (req, res) => {
  const rows = Array.isArray(req.body?.rows) ? req.body.rows : [];
  if (!rows.length) return res.status(400).json({ error: "no_rows", message: "В файле не нашлось строк" });
  const opts = req.body?.options || {};
  const doNumbers = opts.numbers !== false;
  const doSalary = opts.salary !== false;

  const now = new Date().toISOString();
  const matchedOrderIds = new Set();
  const stats = { numbersUpdated: 0, ordersNotFound: 0, employeesCreated: 0, entriesCreated: 0,
                  entriesSkipped: 0, payoutsCreated: 0, debtTotal: 0, paidTotal: 0, coveredMarked: 0 };

  // 1. Сотрудники
  const empId = new Map();
  for (const raw of rows) {
    const name = cleanName(raw.executor);
    if (!name || empId.has(name)) continue;
    let e = db.prepare("SELECT id FROM employees WHERE lower(name) = lower(?)").get(name);
    if (!e && doSalary) {
      const id = uid("emp");
      db.prepare("INSERT INTO employees (id, name, created_at) VALUES (?,?,?)").run(id, name, now);
      e = { id }; stats.employeesCreated++;
    }
    if (e) empId.set(name, e.id);
  }

  // 2. Номера заказов — привязка по коду Kaspi
  if (doNumbers) {
    for (const raw of rows) {
      const kaspiCode = str(raw.kaspiCode, 40);
      const n = num(raw.num);
      if (!kaspiCode || n <= 0) continue;
      const order = db.prepare("SELECT * FROM orders WHERE kaspi_code = ?").get(kaspiCode);
      if (!order) { stats.ordersNotFound++; continue; }
      matchedOrderIds.add(order.id);
      if (order.display_number !== n) {
        db.prepare("UPDATE orders SET display_number = ? WHERE id = ?").run(n, order.id);
        stats.numbersUpdated++;
      }
      // Магазин проставляем, только если он пуст — своё не перетираем
      const shop = str(raw.shop, 20);
      if (shop && !order.shop) db.prepare("UPDATE orders SET shop = ? WHERE id = ?").run(shop, order.id);
    }
  }

  // 3. Перекрытые заказы: помечаем в «Производстве», чтобы они не висели
  // в очереди «ждут решения». Начисление по ним не создаётся — уже оплачено раньше.
  if (doSalary) {
    for (const raw of rows) {
      if (!isCovered(raw)) continue;
      const kaspiCode = str(raw.kaspiCode, 40);
      if (!kaspiCode) continue;
      const order = db.prepare("SELECT * FROM orders WHERE kaspi_code = ?").get(kaspiCode);
      if (!order) continue;
      const existing = db.prepare("SELECT * FROM production WHERE order_id = ?").get(order.id);
      if (existing) {
        if (!existing.decision) {
          db.prepare("UPDATE production SET decision = 'return_offset', resolved_at = ? WHERE id = ?").run(now, existing.id);
          stats.coveredMarked++;
        }
      } else {
        db.prepare(`INSERT INTO production (id, order_id, article, product_name, quantity, shop, decision, resolved_at, created_at)
                    VALUES (?,?,?,?,?,?,'return_offset',?,?)`)
          .run(uid("prod"), order.id, str(raw.article, 60) || order.article,
               str(raw.name, 200) || order.product_name, num(raw.qty) || num(order.qty) || 1,
               str(raw.shop, 20) || order.shop, now, now);
        stats.coveredMarked++;
      }
    }
  }

  // 4. Зарплата: начисления и выплаты
  const payoutBuckets = new Map(); // код выплаты -> список начислений
  if (doSalary) {
    for (const raw of rows) {
      if (isCovered(raw)) continue; // перекрыто возвратом — денег не начисляем
      const name = cleanName(raw.executor);
      const amount = num(raw.amount);
      if (!name || amount <= 0) continue;
      const employeeId = empId.get(name);
      if (!employeeId) continue;

      const kaspiCode = str(raw.kaspiCode, 40);
      const legacyKey = `legacy|${num(raw.num)}|${kaspiCode}|${name}|${amount}`;
      if (db.prepare("SELECT id FROM payroll_entries WHERE legacy_key = ?").get(legacyKey)) {
        stats.entriesSkipped++; continue; // повторный импорт того же файла
      }

      const order = kaspiCode ? db.prepare("SELECT id, shop FROM orders WHERE kaspi_code = ?").get(kaspiCode) : null;
      const paid = payCodeOf(raw.payCode);
      const paidAt = paid ? paid.date + "T12:00:00" : null;
      const id = uid("pay");
      db.prepare(`INSERT INTO payroll_entries
        (id, employee_id, order_id, shop, article, product_name, qty, rate, amount, kind, status,
         comment, accepted_at, accepted_by, created_by, created_at, legacy_key, reported_done,
         assigned_by, assigned_at)
        VALUES (?,?,?,?,?,?,1,?,?,'order',?,?,?,?,?,?,?,0,?,?)`)
        .run(id, employeeId, order ? order.id : null, str(raw.shop, 20) || (order ? order.shop : null),
             str(raw.article, 60), str(raw.name, 200), amount, amount,
             paid ? "paid" : "payable",
             `Перенос из старой системы${paid ? `, выплата ${paid.label}` : ""}`,
             now, req.session.username, req.session.username, now, legacyKey,
             // Автор разноски для перенесённых строк — тот, кто делал перенос:
             // иначе у половины базы графа «кто разнёс» осталась бы пустой
             "перенос: " + req.session.username, now);
      // Дату выплаты проставляем из файла, иначе всё свалится в текущий месяц
      if (paidAt) db.prepare("UPDATE payroll_entries SET paid_at = ? WHERE id = ?").run(paidAt, id);
      stats.entriesCreated++;

      if (paid) {
        stats.paidTotal += amount;
        const key = `${employeeId}|${paid.date}`;
        if (!payoutBuckets.has(key)) payoutBuckets.set(key, { employeeId, code: paid.label, date: paid.date, sum: 0, ids: [] });
        const b = payoutBuckets.get(key);
        b.sum += amount; b.ids.push(id);
      } else {
        stats.debtTotal += amount;
      }
    }

    // Выплаты собираем по коду: одна выплата = один код в старом файле
    let numberRow = db.prepare("SELECT MAX(number) AS n FROM payouts").get();
    let nextNumber = (numberRow && numberRow.n ? numberRow.n : 0) + 1;
    for (const b of payoutBuckets.values()) {
      const payoutId = uid("po");
      db.prepare(`INSERT INTO payouts (id, number, employee_id, accrued, deductions_total, amount, comment, created_by, created_at)
                  VALUES (?,?,?,?,0,?,?,?,?)`)
        .run(payoutId, nextNumber++, b.employeeId, b.sum, b.sum,
             `Перенос из старой системы, выплата ${b.code}`, req.session.username, b.date + "T12:00:00");
      const upd = db.prepare("UPDATE payroll_entries SET payout_id = ? WHERE id = ?");
      b.ids.forEach(id => upd.run(payoutId, id));
      stats.payoutsCreated++;
    }
  }

  logAudit({ user: req.session.username, action: "legacy_import",
             comment: `Номеров ${stats.numbersUpdated}, начислений ${stats.entriesCreated}, перекрыто ${stats.coveredMarked}, долг ${Math.round(stats.debtTotal)}` });
  stats.debtTotal = Math.round(stats.debtTotal);
  stats.paidTotal = Math.round(stats.paidTotal);
  // Отдаём номера заказов из файла и максимальный из них: дальше по ним
  // продолжится сплошная нумерация остальных
  const maxFromFile = rows.reduce((m, r) => Math.max(m, num(r.num) || 0), 0);
  res.json({ ok: true, ...stats, matchedOrderIds: Array.from(matchedOrderIds), maxNumberFromFile: maxFromFile });
});

// Перенумерация «всех остальных подряд» УДАЛЕНА намеренно.
// Именно она ломала нумерацию: раздавала выдуманные номера вроде 9916–9954
// поверх правильных, и заказы переставали биться с Kaspi и старым учётом.
// Номера теперь ставятся только по списку «номер — код Kaspi» (см. ниже),
// а новые заказы берут номер из общего сквозного счётчика.
router.post("/renumber", (req, res) => {
  res.status(410).json({
    error: "removed",
    message: "Массовая перенумерация убрана — она портила номера. Пользуйтесь кнопкой «№ Проставить номера заказов»: там номера ставятся строго по коду Kaspi."
  });
});

// ---------- Откат импорта ----------
// Единственное место во всей программе, которое удаляет начисления. Поэтому:
// удаляем ТОЛЬКО строки с меткой импорта (legacy_key), живые начисления по
// заказам Kaspi не трогаем вообще, и по умолчанию работаем в режиме показа.

// Выплаты, созданные импортом, узнаём по комментарию — своих таких нет
const IMPORT_PAYOUT_MARK = "Перенос из старой системы";

function importedStats() {
  const entries = db.prepare("SELECT * FROM payroll_entries WHERE legacy_key IS NOT NULL").all();
  const payouts = db.prepare("SELECT * FROM payouts WHERE comment LIKE ?").all(IMPORT_PAYOUT_MARK + "%");
  const importPayoutIds = new Set(payouts.map(p => p.id));

  // Если начисление уже вошло в НАСТОЯЩУЮ выплату (не импортную) — удалять его
  // нельзя: рассыплется сумма выданного. Такие показываем отдельно и оставляем.
  const blocked = entries.filter(e => e.payout_id && !importPayoutIds.has(e.payout_id));
  const removable = entries.filter(e => !(e.payout_id && !importPayoutIds.has(e.payout_id)));

  const byEmployee = new Map();
  for (const e of removable) {
    const name = e.employee_id
      ? (db.prepare("SELECT name FROM employees WHERE id = ?").get(e.employee_id)?.name || e.employee_id)
      : "без исполнителя";
    if (!byEmployee.has(name)) byEmployee.set(name, { name, count: 0, sum: 0 });
    const b = byEmployee.get(name);
    b.count++; b.sum += num(e.amount);
  }
  const sum = a => Math.round(a.reduce((s, e) => s + num(e.amount), 0));
  return {
    entries: removable.length,
    entriesSum: sum(removable),
    paidEntries: removable.filter(e => e.status === "paid").length,
    unpaidSum: sum(removable.filter(e => e.status !== "paid")),
    payouts: payouts.length,
    payoutsSum: Math.round(payouts.reduce((s, p) => s + num(p.amount), 0)),
    blocked: blocked.length,
    blockedSum: sum(blocked),
    liveEntries: db.prepare("SELECT COUNT(*) AS n FROM payroll_entries WHERE legacy_key IS NULL").get().n,
    employees: Array.from(byEmployee.values()).map(b => ({ ...b, sum: Math.round(b.sum) }))
                    .sort((a, b) => b.sum - a.sum)
  };
}

// Что будет удалено — смотреть можно сколько угодно, ничего не меняется
router.get("/imported", (req, res) => {
  res.json(importedStats());
});

router.post("/rollback", (req, res) => {
  const stats = importedStats();
  // Защита от случайного нажатия: удаление только по явному подтверждению
  if (req.body?.confirm !== "УДАЛИТЬ") {
    return res.json({ ok: true, dryRun: true, ...stats,
      message: "Ничего не удалено — это предпросмотр. Для удаления пришлите confirm: \"УДАЛИТЬ\"." });
  }
  if (!stats.entries && !stats.payouts) {
    return res.json({ ok: true, deletedEntries: 0, deletedPayouts: 0, message: "Нечего удалять — импортированных строк нет." });
  }

  const payouts = db.prepare("SELECT id FROM payouts WHERE comment LIKE ?").all(IMPORT_PAYOUT_MARK + "%");
  const importPayoutIds = new Set(payouts.map(p => p.id));
  const entries = db.prepare("SELECT * FROM payroll_entries WHERE legacy_key IS NOT NULL").all();

  let deletedEntries = 0, skipped = 0;
  for (const e of entries) {
    if (e.payout_id && !importPayoutIds.has(e.payout_id)) { skipped++; continue; }
    db.prepare("DELETE FROM payroll_entry_log WHERE entry_id = ?").run(e.id);
    db.prepare("DELETE FROM payroll_entries WHERE id = ?").run(e.id);
    deletedEntries++;
  }
  let deletedPayouts = 0;
  for (const p of payouts) {
    // Выплату сносим, только если в ней не осталось чужих начислений
    const left = db.prepare("SELECT COUNT(*) AS n FROM payroll_entries WHERE payout_id = ?").get(p.id).n;
    if (left > 0) continue;
    db.prepare("DELETE FROM payout_deductions WHERE payout_id = ?").run(p.id);
    db.prepare("DELETE FROM payouts WHERE id = ?").run(p.id);
    deletedPayouts++;
  }

  logAudit({ user: req.session.username, action: "legacy_rollback",
             comment: `Удалено начислений ${deletedEntries} на ${stats.entriesSum} ₸, выплат ${deletedPayouts}` });
  res.json({ ok: true, deletedEntries, deletedPayouts, skipped,
             message: `Удалено ${deletedEntries} начислений и ${deletedPayouts} выплат. Теперь можно залить файл заново.` });
});

// ---------- Простановка номеров по списку ----------
// На вход — пары «внутренний номер : код Kaspi» из старого учёта. Разбираем
// текст как есть: из буфера прилетает то через табуляцию, то через пробелы.
function parsePairs(text) {
  const pairs = [];
  const seen = new Set();
  for (const line of String(text || "").split(/[\r\n]+/)) {
    const m = line.trim().match(/^(\d{1,7})\D+(\d{6,20})$/);
    if (!m) continue;
    const number = parseInt(m[1], 10);
    const code = m[2];
    const key = number + "|" + code;
    if (seen.has(key)) continue;
    seen.add(key);
    pairs.push({ number, kaspiCode: code });
  }
  return pairs;
}

function analyzeNumbers(pairs) {
  const found = [], notFound = [], willChange = [], alreadyOk = [];
  const takenBy = new Map();   // номер -> код, чтобы поймать двойников в самом списке
  const numbersOf = new Map(); // код -> номера: один заказ не может иметь два номера
  const dupes = [], multiNumber = [];

  for (const p of pairs) {
    if (takenBy.has(p.number) && takenBy.get(p.number) !== p.kaspiCode) {
      dupes.push({ number: p.number, codes: [takenBy.get(p.number), p.kaspiCode] });
    }
    takenBy.set(p.number, p.kaspiCode);
    // Один и тот же заказ Kaspi под разными номерами: в старом учёте так бывало,
    // когда покупку разносили несколькими строками. Ставим самый ранний номер.
    if (!numbersOf.has(p.kaspiCode)) numbersOf.set(p.kaspiCode, []);
    const list = numbersOf.get(p.kaspiCode);
    if (!list.includes(p.number)) list.push(p.number);
    if (list.length === 2) multiNumber.push({ kaspiCode: p.kaspiCode, numbers: list });

    const order = db.prepare("SELECT id, display_number, shop, product_name FROM orders WHERE kaspi_code = ?").get(p.kaspiCode);
    if (!order) { notFound.push(p); continue; }
    found.push(p);
    if (order.display_number === p.number) alreadyOk.push(p);
    else willChange.push({ ...p, was: order.display_number, shop: order.shop, name: order.product_name });
  }

  // Заказы, которых в списке нет: им номера раздадим подряд после максимума
  const listedCodes = new Set(pairs.map(p => p.kaspiCode));
  const allOrders = db.prepare("SELECT id, kaspi_code, display_number, shop, product_name, created_at FROM orders ORDER BY created_at").all();
  const outside = allOrders.filter(o => !listedCodes.has(String(o.kaspi_code || "")));
  const maxFromList = pairs.reduce((m, p) => Math.max(m, p.number), 0);

  return {
    total: pairs.length,
    found: found.length,
    notFound: notFound.length,
    notFoundExamples: notFound.slice(0, 8).map(p => `${p.number} / ${p.kaspiCode}`),
    willChange: willChange.length,
    alreadyOk: alreadyOk.length,
    changeExamples: willChange.slice(0, 10),
    dupes: dupes.slice(0, 5),
    dupeCount: dupes.length,
    multiNumber: multiNumber.slice(0, 5),
    multiNumberCount: multiNumber.length,
    outsideCount: outside.length,
    outsideExamples: outside.slice(0, 6).map(o => ({ code: o.kaspi_code, was: o.display_number, shop: o.shop, name: o.product_name })),
    maxFromList,
    nextFree: maxFromList + 1
  };
}

router.post("/numbers/preview", (req, res) => {
  const pairs = Array.isArray(req.body?.pairs) ? req.body.pairs : parsePairs(req.body?.text);
  if (!pairs.length) {
    return res.status(400).json({ error: "no_pairs",
      message: "Не нашлось ни одной пары «номер — код Kaspi». Каждая строка должна быть вида: 4226  1012058162" });
  }
  res.json(analyzeNumbers(pairs));
});

router.post("/numbers/apply", (req, res) => {
  const pairs = Array.isArray(req.body?.pairs) ? req.body.pairs : parsePairs(req.body?.text);
  if (!pairs.length) return res.status(400).json({ error: "no_pairs", message: "Список пуст" });
  // Что делать с заказами, которых в файле нет. По умолчанию — снять номер:
  // нет в файле, значит номера нет. Выдуманный номер хуже пустого, потому что
  // выглядит настоящим и не бьётся ни с Kaspi, ни со старым учётом.
  const outside = ["clear", "renumber", "keep"].includes(req.body?.outside) ? req.body.outside : "clear";

  // Если один код Kaspi встречается несколько раз, оставляем самый ранний номер:
  // иначе результат зависел бы от порядка строк в списке
  const earliest = new Map();
  for (const p of pairs) {
    if (!earliest.has(p.kaspiCode) || p.number < earliest.get(p.kaspiCode)) earliest.set(p.kaspiCode, p.number);
  }
  const unique = Array.from(earliest.entries()).map(([kaspiCode, number]) => ({ kaspiCode, number }));

  let updated = 0, notFound = 0, same = 0;
  for (const p of unique) {
    const order = db.prepare("SELECT id, display_number FROM orders WHERE kaspi_code = ?").get(p.kaspiCode);
    if (!order) { notFound++; continue; }
    if (order.display_number === p.number) { same++; continue; }
    db.prepare("UPDATE orders SET display_number = ? WHERE id = ?").run(p.number, order.id);
    updated++;
  }

  const maxFromList = pairs.reduce((m, p) => Math.max(m, p.number), 0);
  const listed = new Set(unique.map(p => String(p.kaspiCode)));
  const rest = db.prepare("SELECT id, kaspi_code, display_number FROM orders ORDER BY created_at, rowid").all()
    .filter(o => !listed.has(String(o.kaspi_code || "")));

  let next = maxFromList + 1, renumbered = 0, cleared = 0;
  if (outside === "renumber") {
    const upd = db.prepare("UPDATE orders SET display_number = ? WHERE id = ?");
    for (const o of rest) { upd.run(next, o.id); next++; renumbered++; }
  } else if (outside === "clear") {
    // Номер снимаем, а не выдумываем: в списке заказа нет — значит нет и номера
    const upd = db.prepare("UPDATE orders SET display_number = NULL WHERE id = ?");
    for (const o of rest) { if (o.display_number != null) { upd.run(o.id); cleared++; } }
  }
  // Сдвигаем общий счётчик, чтобы новые заказы из Kaspi продолжили ряд
  const nextFree = bumpOrderNumber(Math.max(next, maxFromList + 1));

  logAudit({ user: req.session.username, action: "orders_set_numbers",
             comment: `Проставлено ${updated}, снято ${cleared}, перенумеровано ${renumbered}, следующий свободный ${nextFree}` });
  const tail = outside === "renumber" ? ` Остальным выданы номера подряд: ${renumbered}.`
             : outside === "clear" ? ` У ${cleared} заказов вне списка номер снят — они получат его при следующем заказе из Kaspi.`
             : "";
  res.json({ ok: true, updated, same, notFound, renumbered, cleared, nextFree, outside,
             message: `Проставлено номеров: ${updated}.${tail} Следующий свободный номер — ${nextFree}.` });
});

export default router;

import express from "express";
import { db, logAudit } from "../db.js";
import { requireAuth, requireAdmin } from "../middleware/auth.js";

const router = express.Router();
router.use(requireAuth);
router.use(requireAdmin); // перенос трогает деньги и номера заказов — только админ

function uid(prefix) { return prefix + "_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }
function num(v) { const n = Number(v); return Number.isFinite(n) ? n : 0; }
function str(v, max = 300) { return String(v == null ? "" : v).replace(/[\r\n\t]+/g, " ").trim().slice(0, max); }

// Слова, которые в колонке «Исполнитель» означают не человека, а пометку
const NOT_A_PERSON = new Set([
  "перекрыто","перекрыт","перекрытро","прекрыт","возврат","отмена","пропустим",
  "без оплаты","хз","","none","-","—"
]);
// В старом файле имена писали по-разному
const NAME_FIX = { "агдрей": "Андрей", "илья": "Илья", "нурбол": "Нурбол", "андрей": "Андрей", "бекзат": "Бекзат", "слава": "Слава" };

function cleanName(v) {
  const s = str(v, 60);
  const low = s.toLowerCase();
  if (NOT_A_PERSON.has(low)) return null;
  return NAME_FIX[low] || s;
}

// Код выплаты вида «Б1906»: первая буква имени и дата. Если он есть —
// работа уже оплачена, если нет — это долг.
function payCodeOf(v) {
  const s = str(v, 20);
  return /^[АABНHИСБб]\s?\d{4}$/i.test(s) ? s.toUpperCase().replace(/\s/g, "") : null;
}

function analyze(rows) {
  const employees = new Map();
  let matched = 0, notMatched = 0, withRate = 0, paidSum = 0, debtSum = 0, numbered = 0;
  const unmatchedExamples = [];

  for (const raw of rows) {
    const kaspiCode = str(raw.kaspiCode, 40);
    const n = num(raw.num);
    if (kaspiCode && n > 0) {
      const order = db.prepare("SELECT id, display_number FROM orders WHERE kaspi_code = ?").get(kaspiCode);
      if (order) { matched++; if (order.display_number !== n) numbered++; }
      else { notMatched++; if (unmatchedExamples.length < 5) unmatchedExamples.push(`${n} / ${kaspiCode}`); }
    }
    const name = cleanName(raw.executor);
    const amount = num(raw.amount);
    if (!name) continue;
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
    rows: rows.length, matched, notMatched, numbered, withRate,
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
  const stats = { numbersUpdated: 0, ordersNotFound: 0, employeesCreated: 0, entriesCreated: 0, entriesSkipped: 0, payoutsCreated: 0, debtTotal: 0, paidTotal: 0 };

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
      if (order.display_number !== n) {
        db.prepare("UPDATE orders SET display_number = ? WHERE id = ?").run(n, order.id);
        stats.numbersUpdated++;
      }
      // Магазин проставляем, только если он пуст — своё не перетираем
      const shop = str(raw.shop, 20);
      if (shop && !order.shop) db.prepare("UPDATE orders SET shop = ? WHERE id = ?").run(shop, order.id);
    }
  }

  // 3. Зарплата: начисления и выплаты
  const payoutBuckets = new Map(); // код выплаты -> список начислений
  if (doSalary) {
    for (const raw of rows) {
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
      const code = payCodeOf(raw.payCode);
      const id = uid("pay");
      db.prepare(`INSERT INTO payroll_entries
        (id, employee_id, order_id, shop, article, product_name, qty, rate, amount, kind, status,
         comment, accepted_at, accepted_by, created_by, created_at, legacy_key, reported_done)
        VALUES (?,?,?,?,?,?,1,?,?,'order',?,?,?,?,?,?,?,0)`)
        .run(id, employeeId, order ? order.id : null, str(raw.shop, 20) || (order ? order.shop : null),
             str(raw.article, 60), str(raw.name, 200), amount, amount,
             code ? "paid" : "payable",
             `Перенос из старой системы${code ? `, выплата ${code}` : ""}`,
             now, req.session.username, req.session.username, now, legacyKey);
      stats.entriesCreated++;

      if (code) {
        stats.paidTotal += amount;
        const key = `${employeeId}|${code}`;
        if (!payoutBuckets.has(key)) payoutBuckets.set(key, { employeeId, code, sum: 0, ids: [] });
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
             `Перенос из старой системы, код ${b.code}`, req.session.username, now);
      const upd = db.prepare("UPDATE payroll_entries SET payout_id = ?, paid_at = ? WHERE id = ?");
      b.ids.forEach(id => upd.run(payoutId, now, id));
      stats.payoutsCreated++;
    }
  }

  logAudit({ user: req.session.username, action: "legacy_import",
             comment: `Номеров ${stats.numbersUpdated}, начислений ${stats.entriesCreated}, выплат ${stats.payoutsCreated}, долг ${Math.round(stats.debtTotal)}` });
  stats.debtTotal = Math.round(stats.debtTotal);
  stats.paidTotal = Math.round(stats.paidTotal);
  res.json({ ok: true, ...stats });
});

export default router;

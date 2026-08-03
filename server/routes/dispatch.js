import express from "express";
import { db, logAudit } from "../db.js";
import { requireAuth, requirePermission } from "../middleware/auth.js";

const router = express.Router();
router.use(requireAuth);
router.use(requirePermission("production"));

// Менеджер «пуляет» заказы забивщикам: после этого они появляются у них
// в мониторе и их можно взять. До этого заказ виден только в «Производстве».
router.post("/publish", (req, res) => {
  const ids = Array.isArray(req.body?.ids) ? req.body.ids : [];
  if (!ids.length) return res.status(400).json({ error: "no_ids", message: "Не выбрано ни одной позиции" });

  const now = new Date().toISOString();
  // Кому отправляем: конкретному сотруднику или всем (пусто)
  const forEmployee = req.body?.employeeId
    ? (db.prepare("SELECT id FROM employees WHERE id = ?").get(req.body.employeeId) ? req.body.employeeId : null)
    : null;
  const comment = String(req.body?.comment || "").replace(/[\r\n\t]+/g, " ").trim().slice(0, 500) || null;
  let published = 0, skipped = 0;
  for (const id of ids) {
    const row = db.prepare("SELECT * FROM production WHERE id = ?").get(id);
    if (!row) { skipped++; continue; }
    // Уже решённые не отправляем: их либо кто-то взял, либо списали со склада
    if (row.decision) { skipped++; continue; }
    db.prepare(`UPDATE production SET published = 1, published_at = ?, published_by = ?,
                published_for = ?, manager_comment = ? WHERE id = ?`)
      .run(now, req.session.username, forEmployee, comment || row.manager_comment || null, id);
    published++;
  }
  const who = forEmployee ? db.prepare("SELECT name FROM employees WHERE id = ?").get(forEmployee)?.name : "всем";
  logAudit({ user: req.session.username, action: "production_publish", comment: `Отправлено (${who}): ${published}` });
  res.json({ ok: true, published, skipped, forEmployee, forName: who });
});

// Забрать обратно из монитора — пока заказ никто не взял
router.post("/unpublish", (req, res) => {
  const ids = Array.isArray(req.body?.ids) ? req.body.ids : [];
  let count = 0;
  for (const id of ids) {
    const row = db.prepare("SELECT * FROM production WHERE id = ?").get(id);
    if (!row || row.decision) continue;
    db.prepare("UPDATE production SET published = 0 WHERE id = ?").run(id);
    count++;
  }
  res.json({ ok: true, unpublished: count });
});

// Забивщик взял заказ по ошибке — менеджер возвращает его в общий список.
// Начисление при этом отменяется, чтобы деньги не повисли на человеке.
router.post("/release", (req, res) => {
  const ids = Array.isArray(req.body?.ids) ? req.body.ids : [];
  if (!ids.length) return res.status(400).json({ error: "no_ids", message: "Не выбрано ни одной позиции" });

  let released = 0, skipped = 0;
  for (const id of ids) {
    const row = db.prepare("SELECT * FROM production WHERE id = ?").get(id);
    if (!row) { skipped++; continue; }
    const entry = db.prepare("SELECT * FROM payroll_entries WHERE production_id = ? AND status != 'cancelled'").get(row.id);
    // Оплаченное не трогаем: деньги уже выданы, откатывать нечего
    if (entry && entry.status === "paid") { skipped++; continue; }
    if (entry) {
      db.prepare("UPDATE payroll_entries SET status = 'cancelled', comment = ? WHERE id = ?")
        .run("Заказ освобождён менеджером", entry.id);
    }
    db.prepare("UPDATE production SET decision = NULL, employee_id = NULL, resolved_at = NULL, published = 1 WHERE id = ?").run(row.id);
    released++;
  }
  logAudit({ user: req.session.username, action: "production_release", comment: `Освобождено: ${released}` });
  res.json({ ok: true, released, skipped });
});

// Свой список производства: отдаём всё нужное разом — заказ, начисление,
// кому отправлено, комментарий, архив. Раньше приходилось собирать
// из нескольких запросов и часть полей вообще не доходила до экрана.
// Одна строка производства → то, что видит экран. Вынесено в функцию,
// чтобы теми же правилами считать и список, и счётчики на кнопках.
function toItem(p) {
    const order = p.order_id ? db.prepare("SELECT display_number, shop, qty, kaspi_code, product_name FROM orders WHERE id = ?").get(p.order_id) : null;
    const entry = db.prepare("SELECT * FROM payroll_entries WHERE production_id = ? AND status != 'cancelled'").get(p.id);
    const emp = p.employee_id ? db.prepare("SELECT name FROM employees WHERE id = ?").get(p.employee_id) : null;
    const forEmp = p.published_for ? db.prepare("SELECT name FROM employees WHERE id = ?").get(p.published_for) : null;
    const item = p.article ? db.prepare("SELECT labor_rate, photo FROM price_items WHERE article = ?").get(p.article) : null;
    const qty = Number(order?.qty) || Number(p.quantity) || 1;
    const rate = item ? Number(item.labor_rate) || 0 : 0;

    // На каком шаге запись — считаем здесь, чтобы на экране не было разнобоя
    let step = "pending";
    if (p.archived_at) step = "archived";
    else if (p.decision === "stock") step = "from_stock";
    else if (p.decision === "return_offset") step = "covered";
    else if (p.decision === "assigned") {
      if (entry && entry.status === "paid") step = "paid";
      else if (entry && entry.status === "payable") step = "accepted";
      else if (entry && entry.reported_done) step = "reported";
      else step = "in_work";
    } else if (p.published) step = "published";

    return {
      id: p.id, orderId: p.order_id, number: order?.display_number || null,
      shop: order?.shop || p.shop || null, kaspiCode: order?.kaspi_code || null,
      article: p.article, productName: p.product_name || order?.product_name || "",
      photo: item?.photo || null, qty, rate, amount: Math.round(rate * qty),
      decision: p.decision, step,
      employeeId: p.employee_id, employeeName: emp?.name || "",
      published: !!p.published, publishedFor: p.published_for, publishedForName: forEmp?.name || "",
      managerComment: p.manager_comment,
      archivedAt: p.archived_at,
      createdAt: p.created_at,
      entry: entry ? {
        id: entry.id, status: entry.status, amount: Number(entry.amount) || 0,
        reportedDone: !!entry.reported_done, reportedBy: entry.reported_by,
        reportedWeight: entry.reported_weight, acceptedBy: entry.accepted_by
      } : null
    };
}

router.get("/list", (req, res) => {
  const withArchived = req.query.archived === "1";
  // Счётчики на кнопках должны показывать всё, что есть в базе, а не только
  // текущую выборку. Раньше они считались по уже отфильтрованным строкам,
  // поэтому «Архив» в обычном режиме всегда показывал 0, хотя там что-то лежало.
  const allRows = db.prepare("SELECT * FROM production ORDER BY created_at DESC LIMIT 5000").all();
  // Собираем один раз и потом только фильтруем: toItem дёргает базу пять раз
  // на строку, а прогонять его дважды по всему производству — лишняя нагрузка
  const allItems = allRows.map(toItem);
  const items = allItems.filter(i => withArchived ? !!i.archivedAt : !i.archivedAt);

  // Счётчики — по всем строкам производства, чтобы «Архив» и остальные шаги
  // показывали настоящие числа, а не только то, что попало в текущий фильтр
  const counts = allItems.reduce((acc, i) => {
    acc[i.step] = (acc[i.step] || 0) + 1;
    return acc;
  }, {});
  res.json({ items, counts, total: items.length });
});

// В архив уходит то, что уже отработано или больше не нужно.
// Не удаляем: на записи держатся начисления и история.
router.post("/archive", (req, res) => {
  const ids = Array.isArray(req.body?.ids) ? req.body.ids : [];
  const toArchive = req.body?.archived !== false;
  let count = 0;
  for (const id of ids) {
    const row = db.prepare("SELECT * FROM production WHERE id = ?").get(id);
    if (!row) continue;
    db.prepare("UPDATE production SET archived_at = ? WHERE id = ?")
      .run(toArchive ? new Date().toISOString() : null, id);
    count++;
  }
  logAudit({ user: req.session.username, action: toArchive ? "production_archive" : "production_unarchive", comment: `Позиций: ${count}` });
  res.json({ ok: true, count });
});

// Правка строки: количество и комментарий. Сумма пересчитывается по расценке.
router.put("/item/:id", (req, res) => {
  const row = db.prepare("SELECT * FROM production WHERE id = ?").get(req.params.id);
  if (!row) return res.status(404).json({ error: "not_found" });
  const b = req.body || {};
  const updates = [], params = [];
  if (b.quantity !== undefined) {
    const q = Number(b.quantity);
    if (!(q > 0)) return res.status(400).json({ error: "bad_qty", message: "Количество должно быть больше нуля" });
    updates.push("quantity = ?"); params.push(q);
  }
  if (b.comment !== undefined) {
    updates.push("manager_comment = ?");
    params.push(String(b.comment || "").replace(/[\r\n\t]+/g, " ").trim().slice(0, 500) || null);
  }
  if (!updates.length) return res.json({ ok: true });
  params.push(row.id);
  db.prepare(`UPDATE production SET ${updates.join(", ")} WHERE id = ?`).run(...params);

  // Если количество поменяли, а начисление ещё не оплачено — пересчитываем
  if (b.quantity !== undefined) {
    const entry = db.prepare("SELECT * FROM payroll_entries WHERE production_id = ? AND status IN ('pending','payable')").get(row.id);
    if (entry) {
      const amount = Math.round(Number(entry.rate) * Number(b.quantity) * 100) / 100;
      db.prepare("UPDATE payroll_entries SET qty = ?, amount = ? WHERE id = ?").run(Number(b.quantity), amount, entry.id);
    }
  }
  res.json({ ok: true });
});

export default router;import express from "express";
import { db, logAudit } from "../db.js";
import { requireAuth, requirePermission } from "../middleware/auth.js";

const router = express.Router();
router.use(requireAuth);
router.use(requirePermission("production"));

// Менеджер «пуляет» заказы забивщикам: после этого они появляются у них
// в мониторе и их можно взять. До этого заказ виден только в «Производстве».
router.post("/publish", (req, res) => {
  const ids = Array.isArray(req.body?.ids) ? req.body.ids : [];
  if (!ids.length) return res.status(400).json({ error: "no_ids", message: "Не выбрано ни одной позиции" });

  const now = new Date().toISOString();
  // Кому отправляем: конкретному сотруднику или всем (пусто)
  const forEmployee = req.body?.employeeId
    ? (db.prepare("SELECT id FROM employees WHERE id = ?").get(req.body.employeeId) ? req.body.employeeId : null)
    : null;
  const comment = String(req.body?.comment || "").replace(/[\r\n\t]+/g, " ").trim().slice(0, 500) || null;
  let published = 0, skipped = 0;
  for (const id of ids) {
    const row = db.prepare("SELECT * FROM production WHERE id = ?").get(id);
    if (!row) { skipped++; continue; }
    // Уже решённые не отправляем: их либо кто-то взял, либо списали со склада
    if (row.decision) { skipped++; continue; }
    db.prepare(`UPDATE production SET published = 1, published_at = ?, published_by = ?,
                published_for = ?, manager_comment = ? WHERE id = ?`)
      .run(now, req.session.username, forEmployee, comment || row.manager_comment || null, id);
    published++;
  }
  const who = forEmployee ? db.prepare("SELECT name FROM employees WHERE id = ?").get(forEmployee)?.name : "всем";
  logAudit({ user: req.session.username, action: "production_publish", comment: `Отправлено (${who}): ${published}` });
  res.json({ ok: true, published, skipped, forEmployee, forName: who });
});

// Забрать обратно из монитора — пока заказ никто не взял
router.post("/unpublish", (req, res) => {
  const ids = Array.isArray(req.body?.ids) ? req.body.ids : [];
  let count = 0;
  for (const id of ids) {
    const row = db.prepare("SELECT * FROM production WHERE id = ?").get(id);
    if (!row || row.decision) continue;
    db.prepare("UPDATE production SET published = 0 WHERE id = ?").run(id);
    count++;
  }
  res.json({ ok: true, unpublished: count });
});

// Забивщик взял заказ по ошибке — менеджер возвращает его в общий список.
// Начисление при этом отменяется, чтобы деньги не повисли на человеке.
router.post("/release", (req, res) => {
  const ids = Array.isArray(req.body?.ids) ? req.body.ids : [];
  if (!ids.length) return res.status(400).json({ error: "no_ids", message: "Не выбрано ни одной позиции" });

  let released = 0, skipped = 0;
  for (const id of ids) {
    const row = db.prepare("SELECT * FROM production WHERE id = ?").get(id);
    if (!row) { skipped++; continue; }
    const entry = db.prepare("SELECT * FROM payroll_entries WHERE production_id = ? AND status != 'cancelled'").get(row.id);
    // Оплаченное не трогаем: деньги уже выданы, откатывать нечего
    if (entry && entry.status === "paid") { skipped++; continue; }
    if (entry) {
      db.prepare("UPDATE payroll_entries SET status = 'cancelled', comment = ? WHERE id = ?")
        .run("Заказ освобождён менеджером", entry.id);
    }
    db.prepare("UPDATE production SET decision = NULL, employee_id = NULL, resolved_at = NULL, published = 1 WHERE id = ?").run(row.id);
    released++;
  }
  logAudit({ user: req.session.username, action: "production_release", comment: `Освобождено: ${released}` });
  res.json({ ok: true, released, skipped });
});

// Свой список производства: отдаём всё нужное разом — заказ, начисление,
// кому отправлено, комментарий, архив. Раньше приходилось собирать
// из нескольких запросов и часть полей вообще не доходила до экрана.
// Одна строка производства → то, что видит экран. Вынесено в функцию,
// чтобы теми же правилами считать и список, и счётчики на кнопках.
function toItem(p) {
    const order = p.order_id ? db.prepare("SELECT display_number, shop, qty, kaspi_code, product_name FROM orders WHERE id = ?").get(p.order_id) : null;
    const entry = db.prepare("SELECT * FROM payroll_entries WHERE production_id = ? AND status != 'cancelled'").get(p.id);
    const emp = p.employee_id ? db.prepare("SELECT name FROM employees WHERE id = ?").get(p.employee_id) : null;
    const forEmp = p.published_for ? db.prepare("SELECT name FROM employees WHERE id = ?").get(p.published_for) : null;
    const item = p.article ? db.prepare("SELECT labor_rate, photo FROM price_items WHERE article = ?").get(p.article) : null;
    const qty = Number(order?.qty) || Number(p.quantity) || 1;
    const rate = item ? Number(item.labor_rate) || 0 : 0;

    // На каком шаге запись — считаем здесь, чтобы на экране не было разнобоя
    let step = "pending";
    if (p.archived_at) step = "archived";
    else if (p.decision === "stock") step = "from_stock";
    else if (p.decision === "return_offset") step = "covered";
    else if (p.decision === "assigned") {
      if (entry && entry.status === "paid") step = "paid";
      else if (entry && entry.status === "payable") step = "accepted";
      else if (entry && entry.reported_done) step = "reported";
      else step = "in_work";
    } else if (p.published) step = "published";

    return {
      id: p.id, orderId: p.order_id, number: order?.display_number || null,
      shop: order?.shop || p.shop || null, kaspiCode: order?.kaspi_code || null,
      article: p.article, productName: p.product_name || order?.product_name || "",
      photo: item?.photo || null, qty, rate, amount: Math.round(rate * qty),
      decision: p.decision, step,
      employeeId: p.employee_id, employeeName: emp?.name || "",
      published: !!p.published, publishedFor: p.published_for, publishedForName: forEmp?.name || "",
      managerComment: p.manager_comment,
      archivedAt: p.archived_at,
      createdAt: p.created_at,
      entry: entry ? {
        id: entry.id, status: entry.status, amount: Number(entry.amount) || 0,
        reportedDone: !!entry.reported_done, reportedBy: entry.reported_by,
        reportedWeight: entry.reported_weight, acceptedBy: entry.accepted_by
      } : null
    };
}

router.get("/list", (req, res) => {
  const withArchived = req.query.archived === "1";
  // Счётчики на кнопках должны показывать всё, что есть в базе, а не только
  // текущую выборку. Раньше они считались по уже отфильтрованным строкам,
  // поэтому «Архив» в обычном режиме всегда показывал 0, хотя там что-то лежало.
  const allRows = db.prepare("SELECT * FROM production ORDER BY created_at DESC LIMIT 5000").all();
  // Собираем один раз и потом только фильтруем: toItem дёргает базу пять раз
  // на строку, а прогонять его дважды по всему производству — лишняя нагрузка
  const allItems = allRows.map(toItem);
  const items = allItems.filter(i => withArchived ? !!i.archivedAt : !i.archivedAt);

  // Счётчики — по всем строкам производства, чтобы «Архив» и остальные шаги
  // показывали настоящие числа, а не только то, что попало в текущий фильтр
  const counts = allItems.reduce((acc, i) => {
    acc[i.step] = (acc[i.step] || 0) + 1;
    return acc;
  }, {});
  res.json({ items, counts, total: items.length });
});

// В архив уходит то, что уже отработано или больше не нужно.
// Не удаляем: на записи держатся начисления и история.
router.post("/archive", (req, res) => {
  const ids = Array.isArray(req.body?.ids) ? req.body.ids : [];
  const toArchive = req.body?.archived !== false;
  let count = 0;
  for (const id of ids) {
    const row = db.prepare("SELECT * FROM production WHERE id = ?").get(id);
    if (!row) continue;
    db.prepare("UPDATE production SET archived_at = ? WHERE id = ?")
      .run(toArchive ? new Date().toISOString() : null, id);
    count++;
  }
  logAudit({ user: req.session.username, action: toArchive ? "production_archive" : "production_unarchive", comment: `Позиций: ${count}` });
  res.json({ ok: true, count });
});

// Правка строки: количество и комментарий. Сумма пересчитывается по расценке.
router.put("/item/:id", (req, res) => {
  const row = db.prepare("SELECT * FROM production WHERE id = ?").get(req.params.id);
  if (!row) return res.status(404).json({ error: "not_found" });
  const b = req.body || {};
  const updates = [], params = [];
  if (b.quantity !== undefined) {
    const q = Number(b.quantity);
    if (!(q > 0)) return res.status(400).json({ error: "bad_qty", message: "Количество должно быть больше нуля" });
    updates.push("quantity = ?"); params.push(q);
  }
  if (b.comment !== undefined) {
    updates.push("manager_comment = ?");
    params.push(String(b.comment || "").replace(/[\r\n\t]+/g, " ").trim().slice(0, 500) || null);
  }
  if (!updates.length) return res.json({ ok: true });
  params.push(row.id);
  db.prepare(`UPDATE production SET ${updates.join(", ")} WHERE id = ?`).run(...params);

  // Если количество поменяли, а начисление ещё не оплачено — пересчитываем
  if (b.quantity !== undefined) {
    const entry = db.prepare("SELECT * FROM payroll_entries WHERE production_id = ? AND status IN ('pending','payable')").get(row.id);
    if (entry) {
      const amount = Math.round(Number(entry.rate) * Number(b.quantity) * 100) / 100;
      db.prepare("UPDATE payroll_entries SET qty = ?, amount = ? WHERE id = ?").run(Number(b.quantity), amount, entry.id);
    }
  }
  res.json({ ok: true });
});

export default router;

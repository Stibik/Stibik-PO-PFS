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

export default router;

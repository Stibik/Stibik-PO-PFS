import express from "express";
import { db, logAudit } from "../db.js";
import { requireAuth } from "../middleware/auth.js";

const router = express.Router();
router.use(requireAuth);

const STATUSES = ["todo", "doing", "done"];
const KINDS = ["buy", "make", "other"];
const PRIORITIES = ["low", "normal", "high"];

function uid() { return "tsk_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }
function str(v, max = 500) { return String(v == null ? "" : v).replace(/[\r\n\t]+/g, " ").trim().slice(0, max); }
function dateOrNull(v) { const s = String(v || "").trim(); return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null; }

function toJson(r) {
  const emp = r.employee_id ? db.prepare("SELECT name FROM employees WHERE id = ?").get(r.employee_id) : null;
  const today = new Date().toISOString().slice(0, 10);
  return {
    id: r.id, title: r.title, description: r.description,
    kind: r.kind, status: r.status, priority: r.priority,
    employeeId: r.employee_id, employeeName: emp ? emp.name : "",
    dueDate: r.due_date,
    // Просрочка считается, а не хранится: срок прошёл, а задача не закрыта
    overdue: !!(r.due_date && r.due_date < today && r.status !== "done"),
    createdBy: r.created_by, createdAt: r.created_at,
    doneAt: r.done_at, doneBy: r.done_by, isArchived: !!r.is_archived
  };
}

router.get("/", (req, res) => {
  const where = [];
  const params = [];
  if (req.query.archived !== "1") where.push("is_archived = 0");
  if (req.query.employeeId) { where.push("employee_id = ?"); params.push(req.query.employeeId); }
  if (req.query.status && STATUSES.includes(req.query.status)) { where.push("status = ?"); params.push(req.query.status); }
  const rows = db.prepare(`SELECT * FROM tasks ${where.length ? "WHERE " + where.join(" AND ") : ""}
    ORDER BY CASE priority WHEN 'high' THEN 0 WHEN 'normal' THEN 1 ELSE 2 END,
             CASE WHEN due_date IS NULL THEN 1 ELSE 0 END, due_date, created_at DESC`).all(...params);
  res.json(rows.map(toJson));
});

router.post("/", (req, res) => {
  const b = req.body || {};
  const title = str(b.title, 200);
  if (!title) return res.status(400).json({ error: "title_required", message: "Напишите, что нужно сделать" });
  if (b.employeeId && !db.prepare("SELECT id FROM employees WHERE id = ?").get(b.employeeId)) {
    return res.status(400).json({ error: "no_employee", message: "Сотрудник не найден" });
  }
  const id = uid();
  const now = new Date().toISOString();
  db.prepare(`INSERT INTO tasks (id, title, description, kind, status, priority, employee_id, due_date, created_by, created_at, updated_at, is_archived)
              VALUES (?,?,?,?,'todo',?,?,?,?,?,?,0)`)
    .run(id, title, str(b.description, 1000),
         KINDS.includes(b.kind) ? b.kind : "other",
         PRIORITIES.includes(b.priority) ? b.priority : "normal",
         b.employeeId || null, dateOrNull(b.dueDate), req.session.username, now, now);
  logAudit({ user: req.session.username, action: "task_create", comment: title });
  res.json(toJson(db.prepare("SELECT * FROM tasks WHERE id = ?").get(id)));
});

router.put("/:id", (req, res) => {
  const row = db.prepare("SELECT * FROM tasks WHERE id = ?").get(req.params.id);
  if (!row) return res.status(404).json({ error: "not_found" });
  const b = req.body || {};
  const map = {
    title: ["title", v => str(v, 200)],
    description: ["description", v => str(v, 1000)],
    kind: ["kind", v => KINDS.includes(v) ? v : "other"],
    priority: ["priority", v => PRIORITIES.includes(v) ? v : "normal"],
    employeeId: ["employee_id", v => v || null],
    dueDate: ["due_date", dateOrNull]
  };
  const updates = [], params = [];
  for (const [k, [col, conv]] of Object.entries(map)) {
    if (Object.prototype.hasOwnProperty.call(b, k)) { updates.push(`${col} = ?`); params.push(conv(b[k])); }
  }
  if (!updates.length) return res.json(toJson(row));
  updates.push("updated_at = ?");
  params.push(new Date().toISOString(), row.id);
  db.prepare(`UPDATE tasks SET ${updates.join(", ")} WHERE id = ?`).run(...params);
  res.json(toJson(db.prepare("SELECT * FROM tasks WHERE id = ?").get(row.id)));
});

router.post("/:id/status", (req, res) => {
  const row = db.prepare("SELECT * FROM tasks WHERE id = ?").get(req.params.id);
  if (!row) return res.status(404).json({ error: "not_found" });
  const status = String(req.body?.status || "");
  if (!STATUSES.includes(status)) return res.status(400).json({ error: "bad_status", message: "Неизвестный статус" });
  const now = new Date().toISOString();
  db.prepare("UPDATE tasks SET status = ?, done_at = ?, done_by = ?, updated_at = ? WHERE id = ?")
    .run(status, status === "done" ? now : null, status === "done" ? req.session.username : null, now, row.id);
  logAudit({ user: req.session.username, action: "task_status", oldValue: row.status, newValue: status, comment: row.title });
  res.json(toJson(db.prepare("SELECT * FROM tasks WHERE id = ?").get(row.id)));
});

// Задачи не удаляем, а прячем в архив — чтобы не терять историю поручений
router.post("/:id/archive", (req, res) => {
  const row = db.prepare("SELECT * FROM tasks WHERE id = ?").get(req.params.id);
  if (!row) return res.status(404).json({ error: "not_found" });
  const to = req.body?.archived === false ? 0 : 1;
  db.prepare("UPDATE tasks SET is_archived = ?, updated_at = ? WHERE id = ?").run(to, new Date().toISOString(), row.id);
  res.json({ ok: true, isArchived: !!to });
});

export default router;

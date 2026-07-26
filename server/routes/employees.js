import express from "express";
import { db, logAudit } from "../db.js";
import { requireAuth } from "../middleware/auth.js";

const router = express.Router();
router.use(requireAuth);

function uid() {
  return "emp_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

// Минимальный список сотрудников — только имена, чтобы было из кого выбирать
// в "Производстве". Полноценные логины и самоотчёты — отдельный шаг в "Зарплате".
router.get("/", (req, res) => {
  const rows = db.prepare("SELECT * FROM employees WHERE active = 1 ORDER BY name").all();
  res.json(rows.map(r => ({ id: r.id, name: r.name, createdAt: r.created_at })));
});

router.post("/", (req, res) => {
  const name = String(req.body?.name || "").trim();
  if (!name) return res.status(400).json({ error: "name_required", message: "Укажите имя сотрудника" });
  const id = uid();
  const now = new Date().toISOString();
  db.prepare("INSERT INTO employees (id, name, active, created_at) VALUES (?, ?, 1, ?)").run(id, name, now);
  logAudit({ user: req.session.username, action: "employee_add", comment: name });
  res.json({ id, name, createdAt: now });
});

// Мягкое удаление — сотрудник может быть уже привязан к записям производства,
// поэтому не удаляем физически, просто скрываем из списка выбора.
router.delete("/:id", (req, res) => {
  const row = db.prepare("SELECT * FROM employees WHERE id = ?").get(req.params.id);
  if (!row) return res.status(404).json({ error: "not_found" });
  db.prepare("UPDATE employees SET active = 0 WHERE id = ?").run(req.params.id);
  logAudit({ user: req.session.username, action: "employee_remove", comment: row.name });
  res.json({ ok: true });
});

export default router;

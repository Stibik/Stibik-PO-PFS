import express from "express";
import bcrypt from "bcryptjs";
import { db, logAudit } from "../db.js";
import { requireAuth, requireAdmin, permissionsOf, PERMISSIONS, ROLE_PRESETS } from "../middleware/auth.js";

const router = express.Router();

const loginAttempts = new Map();
const MAX_ATTEMPTS = 5;
const LOCK_MS = 5 * 60 * 1000;

const ROLE_LABELS = { admin: "Администратор", manager: "Менеджер", warehouse: "Склад", stitcher: "Забивщик" };
const ROLES = Object.keys(ROLE_LABELS);

router.post("/login", async (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: "missing_fields" });

  const attempt = loginAttempts.get(username) || { count: 0, lockedUntil: 0 };
  if (attempt.lockedUntil && Date.now() < attempt.lockedUntil) {
    const waitMin = Math.ceil((attempt.lockedUntil - Date.now()) / 60000);
    return res.status(429).json({ error: "too_many_attempts", message: `Слишком много попыток. Попробуйте через ${waitMin} мин.` });
  }

  const user = db.prepare("SELECT * FROM users WHERE username = ?").get(username);
  if (!user || !bcrypt.compareSync(password, user.password_hash)) {
    attempt.count++;
    if (attempt.count >= MAX_ATTEMPTS) {
      attempt.lockedUntil = Date.now() + LOCK_MS;
      attempt.count = 0;
    }
    loginAttempts.set(username, attempt);
    return res.status(401).json({ error: "invalid_credentials" });
  }

  // Отключённый сотрудник войти не может, но все его записи и история остаются
  if (user.is_active === 0) {
    logAudit({ user: user.username, action: "login_blocked", comment: "учётная запись отключена" });
    return res.status(403).json({ error: "user_disabled", message: "Учётная запись отключена. Обратитесь к администратору." });
  }

  loginAttempts.delete(username);
  req.session.userId = user.id;
  req.session.username = user.username;
  req.session.role = user.role;
  req.session.permissions = permissionsOf(user);
  logAudit({ user: user.username, action: "login", ip: req.ip });
  res.json({ ok: true, username: user.username, role: user.role, permissions: req.session.permissions });
});

router.post("/logout", (req, res) => {
  const username = req.session.username;
  logAudit({ user: username, action: "logout" });
  req.session.destroy(() => res.json({ ok: true }));
});

router.get("/me", requireAuth, (req, res) => {
  // Права перечитываем из базы: если админ их только что поменял, человеку не
  // придётся выходить и заходить заново
  const user = db.prepare("SELECT * FROM users WHERE id = ?").get(req.session.userId);
  if (!user || user.is_active === 0) {
    return req.session.destroy(() => res.status(401).json({ error: "not_authenticated" }));
  }
  req.session.role = user.role;
  req.session.permissions = permissionsOf(user);
  res.json({
    username: user.username, role: user.role,
    roleLabel: ROLE_LABELS[user.role] || user.role,
    permissions: req.session.permissions,
    employeeId: user.employee_id || null
  });
});

router.post("/change-password", requireAuth, async (req, res) => {
  const { oldPassword, newPassword } = req.body || {};
  if (!oldPassword || !newPassword || newPassword.length < 4) {
    return res.status(400).json({ error: "invalid_input" });
  }
  const user = db.prepare("SELECT * FROM users WHERE id = ?").get(req.session.userId);
  if (!user || !bcrypt.compareSync(oldPassword, user.password_hash)) {
    return res.status(401).json({ error: "wrong_old_password" });
  }
  db.prepare("UPDATE users SET password_hash = ? WHERE id = ?").run(bcrypt.hashSync(newPassword, 10), user.id);
  logAudit({ user: user.username, action: "change_password" });
  res.json({ ok: true });
});

// Справочник ролей и прав — интерфейс строит галочки по нему, а не по своему списку
router.get("/permissions-meta", requireAdmin, (req, res) => {
  res.json({
    roles: ROLES.map(r => ({ key: r, label: ROLE_LABELS[r], preset: ROLE_PRESETS[r] })),
    permissions: PERMISSIONS
  });
});

router.get("/users", requireAdmin, (req, res) => {
  const users = db.prepare("SELECT id, username, role, employee_id, is_active, created_at FROM users").all();
  res.json(users.map(u => {
    const emp = u.employee_id ? db.prepare("SELECT name FROM employees WHERE id = ?").get(u.employee_id) : null;
    const full = db.prepare("SELECT * FROM users WHERE id = ?").get(u.id);
    return {
      id: u.id, username: u.username, role: u.role,
      roleLabel: ROLE_LABELS[u.role] || u.role,
      employeeId: u.employee_id, employeeName: emp ? emp.name : "",
      isActive: u.is_active !== 0,
      permissions: permissionsOf(full),
      created_at: u.created_at
    };
  }));
});

router.post("/users", requireAdmin, (req, res) => {
  const { username, password, role, permissions, employeeId } = req.body || {};
  if (!username || !password || password.length < 4) {
    return res.status(400).json({ error: "invalid_input", message: "Логин и пароль обязательны, пароль — от 4 символов" });
  }
  const finalRole = ROLES.includes(role) ? role : "warehouse";
  const perms = Array.isArray(permissions) && permissions.length
    ? permissions.filter(p => PERMISSIONS.some(x => x.key === p))
    : ROLE_PRESETS[finalRole];
  const id = "u_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  try {
    db.prepare(`INSERT INTO users (id, username, password_hash, role, permissions, employee_id, is_active, created_at)
                VALUES (?,?,?,?,?,?,1,?)`)
      .run(id, username, bcrypt.hashSync(password, 10), finalRole, JSON.stringify(perms),
           employeeId || null, new Date().toISOString());
  } catch (e) {
    return res.status(400).json({ error: "username_taken", message: "Такой логин уже занят" });
  }
  logAudit({ user: req.session.username, action: "create_user", newValue: `${username} (${ROLE_LABELS[finalRole]})` });
  res.json({ ok: true, id });
});

// Смена роли, прав, привязки к сотруднику и пароля
router.put("/users/:id", requireAdmin, (req, res) => {
  const user = db.prepare("SELECT * FROM users WHERE id = ?").get(req.params.id);
  if (!user) return res.status(404).json({ error: "not_found" });
  const b = req.body || {};

  // Себе роль не понижаем: иначе админ снимет с себя права и запрёт систему
  if (user.id === req.session.userId && b.role && b.role !== "admin") {
    return res.status(400).json({ error: "cannot_demote_self", message: "Нельзя снять права администратора с самого себя" });
  }

  const updates = [], params = [];
  if (b.role && ROLES.includes(b.role)) { updates.push("role = ?"); params.push(b.role); }
  if (Array.isArray(b.permissions)) {
    updates.push("permissions = ?");
    params.push(JSON.stringify(b.permissions.filter(p => PERMISSIONS.some(x => x.key === p))));
  }
  if (b.employeeId !== undefined) { updates.push("employee_id = ?"); params.push(b.employeeId || null); }
  if (b.password) {
    if (String(b.password).length < 4) return res.status(400).json({ error: "invalid_input", message: "Пароль — от 4 символов" });
    updates.push("password_hash = ?"); params.push(bcrypt.hashSync(b.password, 10));
  }
  if (!updates.length) return res.json({ ok: true });
  params.push(user.id);
  db.prepare(`UPDATE users SET ${updates.join(", ")} WHERE id = ?`).run(...params);
  logAudit({ user: req.session.username, action: "update_user", newValue: user.username });
  res.json({ ok: true });
});

// Отключение вместо удаления — история действий человека остаётся целой
router.post("/users/:id/toggle-active", requireAdmin, (req, res) => {
  const user = db.prepare("SELECT * FROM users WHERE id = ?").get(req.params.id);
  if (!user) return res.status(404).json({ error: "not_found" });
  if (user.id === req.session.userId) {
    return res.status(400).json({ error: "cannot_disable_self", message: "Нельзя отключить самого себя" });
  }
  const to = user.is_active === 0 ? 1 : 0;
  db.prepare("UPDATE users SET is_active = ? WHERE id = ?").run(to, user.id);
  logAudit({ user: req.session.username, action: to ? "enable_user" : "disable_user", newValue: user.username });
  res.json({ ok: true, isActive: !!to });
});

router.delete("/users/:id", requireAdmin, (req, res) => {
  if (req.params.id === req.session.userId) {
    return res.status(400).json({ error: "cannot_delete_self" });
  }
  const user = db.prepare("SELECT username FROM users WHERE id = ?").get(req.params.id);
  db.prepare("DELETE FROM users WHERE id = ?").run(req.params.id);
  logAudit({ user: req.session.username, action: "delete_user", oldValue: user?.username });
  res.json({ ok: true });
});

export default router;

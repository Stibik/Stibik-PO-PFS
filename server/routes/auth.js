import express from "express";
import bcrypt from "bcryptjs";
import { db, logAudit } from "../db.js";
import { requireAuth, requireAdmin } from "../middleware/auth.js";

const router = express.Router();

const loginAttempts = new Map();
const MAX_ATTEMPTS = 5;
const LOCK_MS = 5 * 60 * 1000;

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

  loginAttempts.delete(username);
  req.session.userId = user.id;
  req.session.username = user.username;
  req.session.role = user.role;
  logAudit({ user: user.username, action: "login", ip: req.ip });
  res.json({ ok: true, username: user.username, role: user.role });
});

router.post("/logout", (req, res) => {
  const username = req.session.username;
  logAudit({ user: username, action: "logout" });
  req.session.destroy(() => res.json({ ok: true }));
});

router.get("/me", requireAuth, (req, res) => {
  res.json({ username: req.session.username, role: req.session.role });
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

router.get("/users", requireAdmin, (req, res) => {
  const users = db.prepare("SELECT id, username, role, created_at FROM users").all();
  res.json(users);
});

router.post("/users", requireAdmin, (req, res) => {
  const { username, password, role } = req.body || {};
  if (!username || !password || password.length < 4) {
    return res.status(400).json({ error: "invalid_input" });
  }
  const finalRole = role === "admin" ? "admin" : "warehouse";
  const id = "u_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  try {
    db.prepare("INSERT INTO users (id, username, password_hash, role, created_at) VALUES (?, ?, ?, ?, ?)")
      .run(id, username, bcrypt.hashSync(password, 10), finalRole, new Date().toISOString());
  } catch (e) {
    return res.status(400).json({ error: "username_taken", message: "Такой логин уже занят" });
  }
  logAudit({ user: req.session.username, action: "create_user", newValue: username + " (" + finalRole + ")" });
  res.json({ ok: true, id });
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

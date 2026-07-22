import express from "express";
import bcrypt from "bcryptjs";
import { db } from "../db.js";
import { requireAuth } from "../middleware/auth.js";

const router = express.Router();

router.post("/login", async (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: "missing_fields" });
  await db.read();
  const user = db.data.users.find(u => u.username === username);
  if (!user || !bcrypt.compareSync(password, user.passwordHash)) {
    return res.status(401).json({ error: "invalid_credentials" });
  }
  req.session.userId = user.id;
  req.session.username = user.username;
  req.session.role = user.role;
  res.json({ ok: true, username: user.username, role: user.role });
});

router.post("/logout", (req, res) => {
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
  await db.read();
  const user = db.data.users.find(u => u.id === req.session.userId);
  if (!user || !bcrypt.compareSync(oldPassword, user.passwordHash)) {
    return res.status(401).json({ error: "wrong_old_password" });
  }
  user.passwordHash = bcrypt.hashSync(newPassword, 10);
  await db.write();
  res.json({ ok: true });
});

export default router;

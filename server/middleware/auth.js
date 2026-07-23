export function requireAuth(req, res, next) {
  if (req.session && req.session.userId) return next();
  return res.status(401).json({ error: "not_authenticated" });
}

export function requireAdmin(req, res, next) {
  if (req.session && req.session.userId && req.session.role === "admin") return next();
  return res.status(403).json({ error: "admin_only", message: "Требуются права администратора" });
}

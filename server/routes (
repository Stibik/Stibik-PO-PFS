import express from "express";
import { db } from "../db.js";
import { requireAdmin } from "../middleware/auth.js";

const router = express.Router();
router.use(requireAdmin);

router.get("/", (req, res) => {
  const limit = Math.min(parseInt(req.query.limit, 10) || 200, 1000);
  const rows = db.prepare("SELECT * FROM audit_log ORDER BY id DESC LIMIT ?").all(limit);
  res.json(rows.map(r => ({
    id: r.id, user: r.user, action: r.action, orderId: r.order_id,
    oldValue: r.old_value, newValue: r.new_value, comment: r.comment,
    ip: r.ip, createdAt: r.created_at
  })));
});

export default router;

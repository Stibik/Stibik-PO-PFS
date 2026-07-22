import express from "express";
import { createRequire } from "module";
const require = createRequire(import.meta.url);
const pkg = require("../package.json");

const router = express.Router();

router.get("/version", (req, res) => {
  res.json({ version: pkg.version });
});

export default router;

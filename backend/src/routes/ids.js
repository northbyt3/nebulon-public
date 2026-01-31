const express = require("express");
const { db } = require("../db");
const { requireAuth } = require("../middleware/auth");
const { HANDLE_COOLDOWN_DAYS } = require("../config");
const { validateHandle } = require("../utils/handles");
const { isReservedHandle } = require("../utils/reserved");
const { nowSeconds, daysToSeconds } = require("../utils/time");

const router = express.Router();

router.get("/check", (req, res) => {
  const input = req.query.handle || "";
  const validation = validateHandle(input);
  if (!validation.ok) {
    return res.json({ available: false, reason: validation.reason });
  }
  const handle = validation.value;
  const reserved = isReservedHandle(db, handle);
  if (reserved) {
    return res.json({ available: false, reason: "reserved" });
  }
  const exists = db
    .prepare("SELECT 1 FROM users WHERE handle = ?")
    .get(handle);
  if (exists) {
    return res.json({ available: false, reason: "taken" });
  }
  return res.json({ available: true });
});

router.patch("/", requireAuth, (req, res) => {
  const input = req.body.handle || "";
  const validation = validateHandle(input);
  if (!validation.ok) {
    return res.status(400).json({ error: validation.reason });
  }
  const handle = validation.value;
  const reserved = isReservedHandle(db, handle);
  if (reserved) {
    return res.status(400).json({ error: "reserved" });
  }
  const existing = db
    .prepare("SELECT 1 FROM users WHERE handle = ?")
    .get(handle);
  if (existing) {
    return res.status(400).json({ error: "taken" });
  }

  const user = db
    .prepare("SELECT handle, handle_changed_at FROM users WHERE wallet = ?")
    .get(req.user.wallet);
  if (!user) {
    return res.status(404).json({ error: "user_not_found" });
  }
  const now = nowSeconds();
  const cooldownSeconds = daysToSeconds(HANDLE_COOLDOWN_DAYS);
  if (user.handle_changed_at && now < user.handle_changed_at + cooldownSeconds) {
    return res.status(400).json({ error: "cooldown" });
  }

  db.prepare(
    "UPDATE users SET handle = ?, handle_changed_at = ?, updated_at = ? WHERE wallet = ?"
  ).run(handle, now, now, req.user.wallet);
  db.prepare(
    "INSERT INTO handle_history (wallet, old_handle, new_handle, changed_at) VALUES (?, ?, ?, ?)"
  ).run(req.user.wallet, user.handle, handle, now);

  const updated = db
    .prepare("SELECT wallet, handle, role FROM users WHERE wallet = ?")
    .get(req.user.wallet);
  return res.json({ user: updated });
});

module.exports = router;

const express = require("express");
const { db } = require("../db");
const { requireAuth, requireAdmin } = require("../middleware/auth");
const { validateHandle } = require("../utils/handles");
const { addReservedWord, removeReservedWord } = require("../utils/reserved");
const { logAudit } = require("../utils/audit");
const { nowSeconds } = require("../utils/time");
const { CONTRACT_STATUSES } = require("../utils/contracts");

const router = express.Router();

router.use(requireAuth);
router.use(requireAdmin);

router.post("/roles/grant", (req, res) => {
  const wallet = (req.body.wallet || "").trim();
  const role = (req.body.role || "").trim();
  if (!wallet || (role !== "admin" && role !== "user")) {
    return res.status(400).json({ error: "invalid_request" });
  }
  const now = nowSeconds();
  const existing = db
    .prepare("SELECT wallet FROM users WHERE wallet = ?")
    .get(wallet);
  if (existing) {
    db.prepare("UPDATE users SET role = ?, updated_at = ? WHERE wallet = ?").run(
      role,
      now,
      wallet
    );
  } else {
    db.prepare(
      "INSERT INTO users (wallet, role, created_at, updated_at) VALUES (?, ?, ?, ?)"
    ).run(wallet, role, now, now);
  }
  logAudit(db, req.user.wallet, "role_grant", "user", wallet, { role });
  return res.json({ wallet, role });
});

router.post("/ids/assign", (req, res) => {
  const wallet = (req.body.wallet || "").trim();
  const handleInput = req.body.handle || "";
  const validation = validateHandle(handleInput);
  if (!wallet || !validation.ok) {
    return res.status(400).json({ error: "invalid_request" });
  }
  const handle = validation.value;
  const existing = db
    .prepare("SELECT wallet FROM users WHERE handle = ?")
    .get(handle);
  if (existing && existing.wallet !== wallet) {
    return res.status(400).json({ error: "taken" });
  }
  const now = nowSeconds();
  const user = db
    .prepare("SELECT handle FROM users WHERE wallet = ?")
    .get(wallet);
  if (user) {
    db.prepare(
      "UPDATE users SET handle = ?, handle_changed_at = ?, updated_at = ? WHERE wallet = ?"
    ).run(handle, now, now, wallet);
    db.prepare(
      "INSERT INTO handle_history (wallet, old_handle, new_handle, changed_at) VALUES (?, ?, ?, ?)"
    ).run(wallet, user.handle, handle, now);
  } else {
    db.prepare(
      "INSERT INTO users (wallet, handle, role, handle_changed_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)"
    ).run(wallet, handle, "user", now, now, now);
    db.prepare(
      "INSERT INTO handle_history (wallet, old_handle, new_handle, changed_at) VALUES (?, ?, ?, ?)"
    ).run(wallet, null, handle, now);
  }
  logAudit(db, req.user.wallet, "assign_handle", "user", wallet, { handle });
  return res.json({ wallet, handle });
});

router.post("/contracts/:id/status", (req, res) => {
  const status = (req.body.status || "").trim();
  if (!CONTRACT_STATUSES.includes(status)) {
    return res.status(400).json({ error: "invalid_status" });
  }
  const contract = db
    .prepare("SELECT id FROM contract_drafts WHERE id = ?")
    .get(req.params.id);
  if (!contract) {
    return res.status(404).json({ error: "contract_not_found" });
  }
  db.prepare("UPDATE contract_drafts SET status = ?, updated_at = ? WHERE id = ?").run(
    status,
    nowSeconds(),
    req.params.id
  );
  logAudit(db, req.user.wallet, "set_contract_status", "contract", req.params.id, {
    status,
  });
  return res.json({ contractId: req.params.id, status });
});

router.post("/invites/:id/cancel", (req, res) => {
  const invite = db
    .prepare("SELECT * FROM invites WHERE id = ?")
    .get(req.params.id);
  if (!invite) {
    return res.status(404).json({ error: "invite_not_found" });
  }
  if (invite.status !== "pending") {
    return res.status(400).json({ error: "invite_not_pending" });
  }
  const now = nowSeconds();
  db.prepare(
    "UPDATE invites SET status = ?, canceled_at = ?, updated_at = ? WHERE id = ?"
  ).run("canceled", now, now, invite.id);
  db.prepare(
    "UPDATE contract_drafts SET status = ?, updated_at = ? WHERE id = ?"
  ).run("invite_canceled", now, invite.contract_id);
  logAudit(db, req.user.wallet, "cancel_invite", "invite", invite.id, {});
  return res.json({ inviteId: invite.id, status: "canceled" });
});

router.post("/reserved-words", (req, res) => {
  const word = (req.body.word || "").trim().toLowerCase();
  const reason = (req.body.reason || "").trim();
  if (!word) {
    return res.status(400).json({ error: "missing_word" });
  }
  addReservedWord(db, word, reason || "admin");
  logAudit(db, req.user.wallet, "add_reserved_word", "reserved_word", word, {
    reason: reason || "admin",
  });
  return res.json({ word });
});

router.delete("/reserved-words/:word", (req, res) => {
  const word = (req.params.word || "").trim().toLowerCase();
  if (!word) {
    return res.status(400).json({ error: "missing_word" });
  }
  removeReservedWord(db, word);
  logAudit(db, req.user.wallet, "remove_reserved_word", "reserved_word", word, {});
  return res.json({ word });
});

router.post("/indexer/tick", (req, res) => {
  // Import the tick function
  const { tick } = require("../indexer");

  // Run indexer tick with verbose output
  tick(true)
    .then(() => {
      logAudit(db, req.user.wallet, "indexer_tick", "system", "indexer", {});
      return res.json({ success: true, message: "Indexer tick completed" });
    })
    .catch((error) => {
      console.error("Manual indexer tick error:", error);
      return res.status(500).json({ error: "indexer_tick_failed", details: error.message });
    });
});

router.post("/indexer/contract/:id/tick", (req, res) => {
  const contractId = req.params.id;

  // Import the processContract function
  const { processContract } = require("../indexer");

  // Get the contract
  const contract = db
    .prepare("SELECT id, status, escrow_pda FROM contract_drafts WHERE id = ?")
    .get(contractId);

  if (!contract) {
    return res.status(404).json({ error: "contract_not_found" });
  }

  if (!contract.escrow_pda) {
    return res.status(400).json({ error: "contract_has_no_escrow" });
  }

  // Process this specific contract
  processContract(contract, true) // verbose=true
    .then(() => {
      logAudit(db, req.user.wallet, "indexer_contract_tick", "contract", contractId, {});
      return res.json({ success: true, message: `Contract ${contractId} indexer update completed` });
    })
    .catch((error) => {
      console.error("Manual contract indexer error:", error);
      return res.status(500).json({ error: "contract_indexer_failed", details: error.message });
    });
});

module.exports = router;

const express = require("express");
const { PublicKey } = require("@solana/web3.js");
const { db } = require("../db");
const { requireAuth } = require("../middleware/auth");
const { nowSeconds } = require("../utils/time");
const { formatContract, formatContracts } = require("../utils/format");
const { processContract } = require("../indexer");

const router = express.Router();

const isParticipant = (contract, wallet) =>
  contract.client_wallet === wallet || contract.contractor_wallet === wallet;

const selectWithUsers = `
  SELECT c.*,
         client.handle AS client_handle,
         client.user_pfp AS client_pfp,
         contractor.handle AS contractor_handle,
         contractor.user_pfp AS contractor_pfp,
         issuer.handle AS issuer_handle,
         issuer.user_pfp AS issuer_pfp
  FROM contract_drafts c
  LEFT JOIN users client ON client.wallet = c.client_wallet
  LEFT JOIN users contractor ON contractor.wallet = c.contractor_wallet
  LEFT JOIN users issuer ON issuer.wallet = c.issuer_wallet
`;

const serializeMilestones = (milestones) => {
  if (milestones === undefined || milestones === null) {
    return null;
  }
  if (!Array.isArray(milestones)) {
    throw new Error("invalid_milestones");
  }
  return JSON.stringify(milestones);
};

router.get("/", requireAuth, (req, res) => {
  if (req.user.role === "admin" && req.query.scope === "all") {
    const rows = db
      .prepare(`${selectWithUsers} ORDER BY c.updated_at DESC`)
      .all();
    return res.json({ contracts: formatContracts(rows) });
  }
  const rows = db
    .prepare(
      `${selectWithUsers} WHERE c.client_wallet = ? OR c.contractor_wallet = ? OR c.issuer_wallet = ? ORDER BY c.created_at ASC`
    )
    .all(req.user.wallet, req.user.wallet, req.user.wallet);
  return res.json({ contracts: formatContracts(rows) });
});

router.get("/:id", requireAuth, (req, res) => {
  const contract = db
    .prepare(`${selectWithUsers} WHERE c.id = ?`)
    .get(req.params.id);
  if (!contract) {
    return res.status(404).json({ error: "contract_not_found" });
  }
  if (!isParticipant(contract, req.user.wallet) && req.user.role !== "admin") {
    return res.status(403).json({ error: "forbidden" });
  }
  return res.json({ contract: formatContract(contract) });
});

router.patch("/:id", requireAuth, (req, res) => {
  const contract = db
    .prepare(`${selectWithUsers} WHERE c.id = ?`)
    .get(req.params.id);
  if (!contract) {
    return res.status(404).json({ error: "contract_not_found" });
  }
  if (!isParticipant(contract, req.user.wallet)) {
    return res.status(403).json({ error: "forbidden" });
  }
  const hasMilestones = req.body.milestones !== undefined;
  const hasTermsHash = req.body.termsHash !== undefined;
  const hasDeadline = req.body.deadline !== undefined;
  const hasTotalPayment = req.body.totalPayment !== undefined;
  const hasTermsEncrypted = req.body.termsEncrypted !== undefined;
  const hasExecutionMode = req.body.executionMode !== undefined;
  const hasNonMilestoneUpdates =
    hasTermsHash || hasDeadline || hasTotalPayment || hasTermsEncrypted;
  const hasOnlyExecutionMode =
    hasExecutionMode && !hasMilestones && !hasNonMilestoneUpdates;
  if (contract.status !== "negotiating") {
    if (hasNonMilestoneUpdates || (!hasMilestones && !hasOnlyExecutionMode)) {
      return res.status(400).json({ error: "invalid_status" });
    }
  }
  if (hasExecutionMode) {
    const mode = (req.body.executionMode || "").toString().toLowerCase();
    const allowedStatuses = new Set(["waiting_for_init", "negotiating", "awaiting_signatures"]);
    if (!allowedStatuses.has(contract.status)) {
      return res.status(400).json({ error: "invalid_status" });
    }
    if (mode !== "per" && mode !== "l1") {
      return res.status(400).json({ error: "invalid_execution_mode" });
    }
  }

  const updates = [];
  const values = [];

  if (hasTermsHash) {
    updates.push("terms_hash = ?");
    values.push(req.body.termsHash || null);
  }
  if (hasDeadline) {
    updates.push("deadline = ?");
    values.push(req.body.deadline || null);
  }
  if (hasTotalPayment) {
    updates.push("total_payment = ?");
    values.push(req.body.totalPayment || null);
  }
  if (hasTermsEncrypted) {
    updates.push("terms_encrypted = ?");
    values.push(req.body.termsEncrypted || null);
    updates.push("deadline = ?");
    values.push(null);
    updates.push("total_payment = ?");
    values.push(null);
  }
  if (hasMilestones) {
    try {
      const serialized = serializeMilestones(req.body.milestones);
      updates.push("milestones_json = ?");
      values.push(serialized);
    } catch (error) {
      return res.status(400).json({ error: "invalid_milestones" });
    }
  }
  if (hasExecutionMode) {
    updates.push("execution_mode = ?");
    values.push((req.body.executionMode || "").toString().toLowerCase());
  }

  if (!updates.length) {
    return res.status(400).json({ error: "no_changes" });
  }

  updates.push("updated_at = ?");
  values.push(nowSeconds());
  values.push(req.params.id);

  db.prepare(`UPDATE contract_drafts SET ${updates.join(", ")} WHERE id = ?`).run(
    ...values
  );
  const updated = db
    .prepare(`${selectWithUsers} WHERE c.id = ?`)
    .get(req.params.id);
  return res.json({ contract: formatContract(updated) });
});

router.post("/:id/lock", requireAuth, (req, res) => {
  const contract = db
    .prepare(`${selectWithUsers} WHERE c.id = ?`)
    .get(req.params.id);
  if (!contract) {
    return res.status(404).json({ error: "contract_not_found" });
  }
  if (!isParticipant(contract, req.user.wallet)) {
    return res.status(403).json({ error: "forbidden" });
  }
  const hasMilestones = req.body.milestones !== undefined;
  const hasTermsHash = req.body.termsHash !== undefined;
  const hasDeadline = req.body.deadline !== undefined;
  const hasTotalPayment = req.body.totalPayment !== undefined;
  const hasTermsEncrypted = req.body.termsEncrypted !== undefined;
  const hasNonMilestoneUpdates =
    hasTermsHash || hasDeadline || hasTotalPayment || hasTermsEncrypted;
  if (contract.status !== "negotiating") {
    if (!hasMilestones || hasNonMilestoneUpdates) {
      return res.status(400).json({ error: "invalid_status" });
    }
  }
  const hasPlainTerms = contract.deadline && contract.total_payment;
  const hasEncryptedTerms = !!contract.terms_encrypted;
  if (!contract.terms_hash || (!hasPlainTerms && !hasEncryptedTerms)) {
    return res.status(400).json({ error: "missing_terms" });
  }
  const now = nowSeconds();
  db.prepare("UPDATE contract_drafts SET status = ?, updated_at = ? WHERE id = ?").run(
    "awaiting_signatures",
    now,
    contract.id
  );
  const updated = db
    .prepare(`${selectWithUsers} WHERE c.id = ?`)
    .get(contract.id);
  return res.json({ contract: formatContract(updated) });
});

router.post("/:id/sign", requireAuth, (req, res) => {
  const contract = db
    .prepare(`${selectWithUsers} WHERE c.id = ?`)
    .get(req.params.id);
  if (!contract) {
    return res.status(404).json({ error: "contract_not_found" });
  }
  if (!isParticipant(contract, req.user.wallet)) {
    return res.status(403).json({ error: "forbidden" });
  }
  if (contract.status !== "awaiting_signatures") {
    return res.status(400).json({ error: "invalid_status" });
  }
  const now = nowSeconds();
  const updates = [];
  const values = [];

  let nextClientSigned = contract.client_signed_at;
  let nextContractorSigned = contract.contractor_signed_at;

  if (contract.client_wallet === req.user.wallet && !contract.client_signed_at) {
    updates.push("client_signed_at = ?");
    values.push(now);
    nextClientSigned = now;
  }
  if (
    contract.contractor_wallet === req.user.wallet &&
    !contract.contractor_signed_at
  ) {
    updates.push("contractor_signed_at = ?");
    values.push(now);
    nextContractorSigned = now;
  }
  if (!updates.length) {
    return res.status(400).json({ error: "already_signed" });
  }

  const nextStatus = nextClientSigned && nextContractorSigned
    ? "waiting_for_funding"
    : "awaiting_signatures";

  updates.push("status = ?");
  values.push(nextStatus);
  updates.push("updated_at = ?");
  values.push(now);
  values.push(contract.id);

  db.prepare(`UPDATE contract_drafts SET ${updates.join(", ")} WHERE id = ?`).run(
    ...values
  );
  const updated = db
    .prepare(`${selectWithUsers} WHERE c.id = ?`)
    .get(contract.id);
  return res.json({ contract: formatContract(updated) });
});

router.post("/:id/link-escrow", requireAuth, (req, res) => {
  const contract = db
    .prepare(`${selectWithUsers} WHERE c.id = ?`)
    .get(req.params.id);
  if (!contract) {
    return res.status(404).json({ error: "contract_not_found" });
  }
  if (!isParticipant(contract, req.user.wallet)) {
    return res.status(403).json({ error: "forbidden" });
  }
  const { escrowPda, mint, vaultToken } = req.body;
  if (!escrowPda) {
    return res.status(400).json({ error: "missing_escrow_pda" });
  }
  // Validate escrowPda is a valid base58 public key
  try {
    new PublicKey(escrowPda);
  } catch (error) {
    return res.status(400).json({ error: "invalid_escrow_pda", details: error.message });
  }
  const nextStatus =
    contract.status === "waiting_for_init" ? "negotiating" : contract.status;
  db.prepare(
    "UPDATE contract_drafts SET escrow_pda = ?, mint = ?, vault_token = ?, status = ?, updated_at = ? WHERE id = ?"
  ).run(
    escrowPda,
    mint || null,
    vaultToken || null,
    nextStatus,
    nowSeconds(),
    contract.id
  );
  const updated = db
    .prepare(`${selectWithUsers} WHERE c.id = ?`)
    .get(contract.id);
  return res.json({ contract: formatContract(updated) });
});

router.post("/:id/rate", requireAuth, (req, res) => {
  const contract = db
    .prepare(`${selectWithUsers} WHERE c.id = ?`)
    .get(req.params.id);
  if (!contract) {
    return res.status(404).json({ error: "contract_not_found" });
  }
  if (!isParticipant(contract, req.user.wallet)) {
    return res.status(403).json({ error: "forbidden" });
  }
  if (contract.status !== "completed") {
    return res.status(400).json({ error: "invalid_status" });
  }

  const score = Number(req.body.score);
  if (!Number.isInteger(score) || score < 1 || score > 5) {
    return res.status(400).json({ error: "invalid_score" });
  }

  const rateeWallet =
    contract.client_wallet === req.user.wallet
      ? contract.contractor_wallet
      : contract.contractor_wallet === req.user.wallet
        ? contract.client_wallet
        : null;
  if (!rateeWallet) {
    return res.status(400).json({ error: "invalid_ratee" });
  }

  const existing = db
    .prepare("SELECT id FROM ratings WHERE contract_id = ? AND rater_wallet = ?")
    .get(contract.id, req.user.wallet);
  if (existing) {
    return res.status(400).json({ error: "already_rated" });
  }

  db.prepare(
    "INSERT INTO ratings (contract_id, rater_wallet, ratee_wallet, score, created_at) VALUES (?, ?, ?, ?, ?)"
  ).run(contract.id, req.user.wallet, rateeWallet, score, nowSeconds());

  return res.json({ success: true, score });
});

router.post("/:id/mark-funded", requireAuth, (req, res) => {
  const contract = db
    .prepare("SELECT * FROM contract_drafts WHERE id = ?")
    .get(req.params.id);
  if (!contract) {
    return res.status(404).json({ error: "contract_not_found" });
  }
  if (!isParticipant(contract, req.user.wallet) && req.user.role !== "admin") {
    return res.status(403).json({ error: "forbidden" });
  }
  if (contract.status !== "waiting_for_funding") {
    return res.status(400).json({ error: "invalid_status" });
  }
  const now = nowSeconds();
  db.prepare("UPDATE contract_drafts SET status = ?, updated_at = ? WHERE id = ?").run(
    "waiting_for_milestones_report",
    now,
    contract.id
  );
  const updated = db
    .prepare("SELECT * FROM contract_drafts WHERE id = ?")
    .get(contract.id);
  return res.json({ contract: formatContract(updated) });
});

router.post("/:id/refresh", requireAuth, async (req, res) => {
  const contract = db
    .prepare("SELECT * FROM contract_drafts WHERE id = ?")
    .get(req.params.id);
  if (!contract) {
    return res.status(404).json({ error: "contract_not_found" });
  }
  if (!isParticipant(contract, req.user.wallet) && req.user.role !== "admin") {
    return res.status(403).json({ error: "forbidden" });
  }
  if (!contract.escrow_pda) {
    return res.status(400).json({ error: "contract_has_no_escrow" });
  }
  try {
    await processContract(contract, true);
  } catch (error) {
    return res.status(500).json({ error: "contract_refresh_failed" });
  }
  const updated = db
    .prepare(`${selectWithUsers} WHERE c.id = ?`)
    .get(contract.id);
  return res.json({ contract: formatContract(updated) });
});

router.get("/:id/keys", requireAuth, (req, res) => {
  const contract = db
    .prepare(`${selectWithUsers} WHERE c.id = ?`)
    .get(req.params.id);
  if (!contract) {
    return res.status(404).json({ error: "contract_not_found" });
  }
  if (!isParticipant(contract, req.user.wallet) && req.user.role !== "admin") {
    return res.status(403).json({ error: "forbidden" });
  }
  const keys = db
    .prepare(
      "SELECT wallet, public_key, created_at, updated_at FROM contract_keys WHERE contract_id = ? ORDER BY created_at ASC"
    )
    .all(contract.id);
  return res.json({ keys });
});

router.post("/:id/keys", requireAuth, (req, res) => {
  const contract = db
    .prepare(`${selectWithUsers} WHERE c.id = ?`)
    .get(req.params.id);
  if (!contract) {
    return res.status(404).json({ error: "contract_not_found" });
  }
  if (!isParticipant(contract, req.user.wallet) && req.user.role !== "admin") {
    return res.status(403).json({ error: "forbidden" });
  }

  const publicKey = (req.body.publicKey || "").trim();
  if (!publicKey) {
    return res.status(400).json({ error: "missing_public_key" });
  }
  if (publicKey.length > 256) {
    return res.status(400).json({ error: "invalid_public_key" });
  }

  const now = nowSeconds();
  db.prepare(
    `INSERT INTO contract_keys (contract_id, wallet, public_key, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(contract_id, wallet) DO UPDATE SET public_key = excluded.public_key, updated_at = excluded.updated_at`
  ).run(contract.id, req.user.wallet, publicKey, now, now);

  return res.json({ ok: true });
});

module.exports = router;

const express = require("express");
const crypto = require("crypto");
const { db } = require("../db");
const { requireAuth } = require("../middleware/auth");
const { INVITE_TTL_DAYS, BASE_URL } = require("../config");
const { randomToken, hashToken } = require("../utils/crypto");
const { nowSeconds, daysToSeconds } = require("../utils/time");
const { isValidWallet } = require("../utils/solana");
const { normalizeHandle } = require("../utils/handles");
const { formatContract } = require("../utils/format");

const selectWithUsers = `
  SELECT c.*,
         client.handle AS client_handle,
         contractor.handle AS contractor_handle,
         issuer.handle AS issuer_handle
  FROM contract_drafts c
  LEFT JOIN users client ON client.wallet = c.client_wallet
  LEFT JOIN users contractor ON contractor.wallet = c.contractor_wallet
  LEFT JOIN users issuer ON issuer.wallet = c.issuer_wallet
`;

const router = express.Router();

const isRole = (value) => value === "client" || value === "contractor";

const markInviteExpiredIfNeeded = (invite) => {
  if (invite.status !== "pending") {
    return invite;
  }
  if (invite.expires_at >= nowSeconds()) {
    return invite;
  }
  db.prepare(
    "UPDATE invites SET status = ?, updated_at = ? WHERE id = ?"
  ).run("expired", nowSeconds(), invite.id);
  db.prepare(
    "UPDATE contract_drafts SET status = ?, updated_at = ? WHERE id = ?"
  ).run("invite_expired", nowSeconds(), invite.contract_id);
  return { ...invite, status: "expired" };
};

const acceptInviteForUser = (invite, wallet) => {
  const checked = markInviteExpiredIfNeeded(invite);
  if (checked.status !== "pending") {
    return { error: "invite_not_pending", status: 400 };
  }
  if (checked.issuer_wallet === wallet) {
    return { error: "issuer_cannot_accept", status: 400 };
  }
  if (checked.invitee_wallet && checked.invitee_wallet !== wallet) {
    return { error: "not_invited", status: 403 };
  }

  const now = nowSeconds();
  db.prepare(
    "UPDATE invites SET status = ?, accepted_by = ?, accepted_at = ?, updated_at = ?, invitee_wallet = COALESCE(invitee_wallet, ?) WHERE id = ?"
  ).run("accepted", wallet, now, now, wallet, checked.id);

  const contract = db
    .prepare("SELECT * FROM contract_drafts WHERE id = ?")
    .get(checked.contract_id);
  if (!contract) {
    return { error: "contract_not_found", status: 404 };
  }

  const updates = [];
  const values = [];
  if (checked.invitee_role === "client") {
    updates.push("client_wallet = ?");
    values.push(wallet);
  } else {
    updates.push("contractor_wallet = ?");
    values.push(wallet);
  }
  updates.push("status = ?");
  values.push("waiting_for_init");
  updates.push("updated_at = ?");
  values.push(now);
  values.push(checked.contract_id);

  db.prepare(`UPDATE contract_drafts SET ${updates.join(", ")} WHERE id = ?`).run(
    ...values
  );

  const updatedContract = db
    .prepare(`${selectWithUsers} WHERE c.id = ?`)
    .get(checked.contract_id);
  return { 
    contractId: checked.contract_id, 
    status: "negotiating",
    contract: formatContract(updatedContract)
  };
};

const resolveInvitee = (handle, wallet) => {
  if (handle) {
    const normalized = normalizeHandle(handle);
    if (!normalized) {
      return { error: "invalid_handle" };
    }
    const user = db
      .prepare("SELECT wallet, handle FROM users WHERE handle = ?")
      .get(normalized);
    if (!user) {
      return { error: "invitee_not_found" };
    }
    return { wallet: user.wallet, handle: user.handle };
  }
  if (wallet) {
    if (!isValidWallet(wallet)) {
      return { error: "invalid_wallet" };
    }
    return { wallet };
  }
  return { wallet: null };
};

const refreshPendingInvites = (wallet) => {
  const pending = db
    .prepare(
      "SELECT * FROM invites WHERE status = 'pending' AND (issuer_wallet = ? OR invitee_wallet = ?)"
    )
    .all(wallet, wallet);
  pending.forEach((invite) => markInviteExpiredIfNeeded(invite));
};

router.get("/", requireAuth, (req, res) => {
  refreshPendingInvites(req.user.wallet);

  const sent = db
    .prepare(
      `SELECT i.*,\n        issuer.handle AS issuer_handle,\n        invitee.handle AS invitee_handle,\n        accepter.handle AS accepted_handle,\n        contracts.status AS contract_status\n       FROM invites i\n       LEFT JOIN users issuer ON issuer.wallet = i.issuer_wallet\n       LEFT JOIN users invitee ON invitee.wallet = i.invitee_wallet\n       LEFT JOIN users accepter ON accepter.wallet = i.accepted_by\n       LEFT JOIN contract_drafts contracts ON contracts.id = i.contract_id\n       WHERE i.issuer_wallet = ? AND i.status IN ('pending','accepted')\n       ORDER BY i.updated_at DESC`
    )
    .all(req.user.wallet);

  const received = db
    .prepare(
      `SELECT i.*,\n        issuer.handle AS issuer_handle,\n        invitee.handle AS invitee_handle,\n        accepter.handle AS accepted_handle,\n        contracts.status AS contract_status\n       FROM invites i\n       LEFT JOIN users issuer ON issuer.wallet = i.issuer_wallet\n       LEFT JOIN users invitee ON invitee.wallet = i.invitee_wallet\n       LEFT JOIN users accepter ON accepter.wallet = i.accepted_by\n       LEFT JOIN contract_drafts contracts ON contracts.id = i.contract_id\n       WHERE i.invitee_wallet = ? AND i.status IN ('pending','accepted')\n       ORDER BY i.updated_at DESC`
    )
    .all(req.user.wallet);

  return res.json({ sent, received });
});

router.post("/", requireAuth, (req, res) => {
  const inviteeRole = (req.body.inviteeRole || "").trim().toLowerCase();
  if (!isRole(inviteeRole)) {
    return res.status(400).json({ error: "invalid_role" });
  }

  const inviteeHandle = (req.body.inviteeHandle || "").trim();
  const inviteeWalletInput = (req.body.inviteeWallet || "").trim();
  const resolved = resolveInvitee(inviteeHandle, inviteeWalletInput);
  if (resolved.error) {
    const status = resolved.error === "invitee_not_found" ? 404 : 400;
    return res.status(status).json({ error: resolved.error });
  }

  if (resolved.wallet && resolved.wallet === req.user.wallet) {
    return res.status(400).json({ error: "cannot_invite_self" });
  }

  const issuerRole = inviteeRole === "client" ? "contractor" : "client";
  const contractId = crypto.randomUUID();
  const inviteId = crypto.randomUUID();
  const token = randomToken();
  const tokenHash = hashToken(token);
  const now = nowSeconds();
  const expiresAt = now + daysToSeconds(INVITE_TTL_DAYS);

  const clientWallet = issuerRole === "client" ? req.user.wallet : null;
  const contractorWallet = issuerRole === "contractor" ? req.user.wallet : null;

  db.prepare(
    "INSERT INTO contract_drafts (id, issuer_wallet, client_wallet, contractor_wallet, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)"
  ).run(
    contractId,
    req.user.wallet,
    clientWallet,
    contractorWallet,
    "pending_invite",
    now,
    now
  );

  db.prepare(
    "INSERT INTO invites (id, issuer_wallet, invitee_role, invitee_wallet, token_hash, status, expires_at, contract_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
  ).run(
    inviteId,
    req.user.wallet,
    inviteeRole,
    resolved.wallet || null,
    tokenHash,
    "pending",
    expiresAt,
    contractId,
    now,
    now
  );

  const inviteUrl = `${BASE_URL}/invite/${token}`;
  return res.json({ inviteId, token, inviteUrl, contractId, expiresAt });
});

router.post("/preview", (req, res) => {
  const token = (req.body.token || "").trim();
  if (!token) {
    return res.status(400).json({ error: "missing_token" });
  }
  const tokenHash = hashToken(token);
  const invite = db
    .prepare("SELECT * FROM invites WHERE token_hash = ?")
    .get(tokenHash);
  if (!invite) {
    return res.status(404).json({ error: "invite_not_found" });
  }
  const checked = markInviteExpiredIfNeeded(invite);
  const issuer = db
    .prepare("SELECT handle FROM users WHERE wallet = ?")
    .get(invite.issuer_wallet);
  return res.json({
    inviteId: invite.id,
    issuerHandle: issuer ? issuer.handle : null,
    inviteeRole: invite.invitee_role,
    expiresAt: invite.expires_at,
    status: checked.status,
  });
});

router.post("/accept", requireAuth, (req, res) => {
  const token = (req.body.token || "").trim();
  if (!token) {
    return res.status(400).json({ error: "missing_token" });
  }
  const tokenHash = hashToken(token);
  let invite = db
    .prepare("SELECT * FROM invites WHERE token_hash = ?")
    .get(tokenHash);
  if (!invite) {
    return res.status(404).json({ error: "invite_not_found" });
  }
  const result = acceptInviteForUser(invite, req.user.wallet);
  if (result.error) {
    return res.status(result.status || 400).json({ error: result.error });
  }
  return res.json(result);
});

router.post("/accept-id", requireAuth, (req, res) => {
  const inviteId = (req.body.inviteId || "").trim();
  const contractId = (req.body.contractId || "").trim();
  if (!inviteId && !contractId) {
    return res.status(400).json({ error: "missing_identifier" });
  }
  let invite = inviteId
    ? db.prepare("SELECT * FROM invites WHERE id = ?").get(inviteId)
    : db.prepare("SELECT * FROM invites WHERE contract_id = ?").get(contractId);

  if (!invite) {
    return res.status(404).json({ error: "invite_not_found" });
  }
  if (invite.invitee_wallet !== req.user.wallet) {
    return res.status(403).json({ error: "not_invited" });
  }

  const result = acceptInviteForUser(invite, req.user.wallet);
  if (result.error) {
    return res.status(result.status || 400).json({ error: result.error });
  }
  return res.json(result);
});

router.post("/decline", requireAuth, (req, res) => {
  const inviteId = (req.body.inviteId || "").trim();
  const contractId = (req.body.contractId || "").trim();
  if (!inviteId && !contractId) {
    return res.status(400).json({ error: "missing_identifier" });
  }
  const invite = inviteId
    ? db.prepare("SELECT * FROM invites WHERE id = ?").get(inviteId)
    : db.prepare("SELECT * FROM invites WHERE contract_id = ?").get(contractId);

  if (!invite) {
    return res.status(404).json({ error: "invite_not_found" });
  }
  invite = markInviteExpiredIfNeeded(invite);
  if (invite.status !== "pending") {
    return res.status(400).json({ error: "invite_not_pending" });
  }
  if (invite.invitee_wallet !== req.user.wallet) {
    return res.status(403).json({ error: "not_invited" });
  }

  const now = nowSeconds();
  db.prepare(
    "UPDATE invites SET status = ?, updated_at = ?, canceled_at = ? WHERE id = ?"
  ).run("declined", now, now, invite.id);
  db.prepare(
    "UPDATE contract_drafts SET status = ?, updated_at = ? WHERE id = ?"
  ).run("invite_declined", now, invite.contract_id);

  return res.json({ contractId: invite.contract_id, status: "declined" });
});

router.post("/:id/cancel", requireAuth, (req, res) => {
  const invite = db
    .prepare("SELECT * FROM invites WHERE id = ?")
    .get(req.params.id);
  if (!invite) {
    return res.status(404).json({ error: "invite_not_found" });
  }
  const isIssuer = invite.issuer_wallet === req.user.wallet;
  if (!isIssuer && req.user.role !== "admin") {
    return res.status(403).json({ error: "forbidden" });
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
  return res.json({ inviteId: invite.id, status: "canceled" });
});

module.exports = router;

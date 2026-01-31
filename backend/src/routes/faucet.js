const express = require("express");
const rateLimit = require("express-rate-limit");
const { Connection, PublicKey } = require("@solana/web3.js");
const {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountIdempotent,
  createMint,
  getMint,
  mintToChecked,
} = require("@solana/spl-token");
const { db } = require("../db");
const { requireAuth } = require("../middleware/auth");
const {
  SOLANA_RPC_URL,
  FAUCET_ENABLED,
  FAUCET_AMOUNT,
  FAUCET_COOLDOWN_HOURS,
  FAUCET_ALLOWED_NETWORKS,
} = require("../config");
const { nowSeconds } = require("../utils/time");
const { normalizeNetwork } = require("../utils/network");
const { getMintKeypair, getPayerKeypair } = require("../utils/faucet-mint");

const router = express.Router();

const formatPst = (unixSeconds) =>
  new Date(unixSeconds * 1000).toLocaleString("en-US", {
    timeZone: "America/Los_Angeles",
    year: "numeric",
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: true,
    timeZoneName: "short",
  });

const ipLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
});

const isAllowedNetwork = (network) => {
  if (!FAUCET_ALLOWED_NETWORKS.length) {
    return false;
  }
  return FAUCET_ALLOWED_NETWORKS.includes(network);
};

router.get("/status", requireAuth, (req, res) => {
  const network = normalizeNetwork(SOLANA_RPC_URL);
  const enabled = FAUCET_ENABLED && isAllowedNetwork(network);
  const wallet = req.user.wallet;
  const now = nowSeconds();
  const cooldownSeconds = FAUCET_COOLDOWN_HOURS * 60 * 60;
  const ip = req.ip || "unknown";

  const lastWallet = db
    .prepare(
      "SELECT requested_at FROM faucet_requests WHERE wallet = ? ORDER BY requested_at DESC LIMIT 1"
    )
    .get(wallet);
  const lastIp = db
    .prepare(
      "SELECT requested_at FROM faucet_requests WHERE ip = ? ORDER BY requested_at DESC LIMIT 1"
    )
    .get(ip);

  const walletRetryAt = lastWallet
    ? lastWallet.requested_at + cooldownSeconds
    : now;
  const ipRetryAt = lastIp ? lastIp.requested_at + cooldownSeconds : now;
  const nextAvailableAt = Math.max(walletRetryAt, ipRetryAt);
  const canRequest = enabled && now >= nextAvailableAt;

  let reason = null;
  if (!enabled) {
    reason = "faucet_disabled";
  } else if (now < walletRetryAt) {
    reason = "wallet_rate_limited";
  } else if (now < ipRetryAt) {
    reason = "ip_rate_limited";
  }

  return res.json({
    enabled,
    network,
    cooldownSeconds,
    lastRequestedAt: lastWallet ? lastWallet.requested_at : null,
    nextAvailableAt,
    nextAvailableAtPst: formatPst(nextAvailableAt),
    canRequest,
    reason,
  });
});

router.post("/tusdc", ipLimiter, requireAuth, async (req, res) => {
  if (!FAUCET_ENABLED) {
    return res.status(403).json({ error: "faucet_disabled" });
  }

  const network = normalizeNetwork(SOLANA_RPC_URL);
  if (!isAllowedNetwork(network)) {
    return res.status(403).json({ error: "faucet_network_blocked", network });
  }

  const wallet = req.user.wallet;
  const ip = req.ip || "unknown";
  const now = nowSeconds();
  const cooldownSeconds = FAUCET_COOLDOWN_HOURS * 60 * 60;

  const lastWallet = db
    .prepare(
      "SELECT requested_at FROM faucet_requests WHERE wallet = ? ORDER BY requested_at DESC LIMIT 1"
    )
    .get(wallet);
  if (lastWallet && now < lastWallet.requested_at + cooldownSeconds) {
    const retryAt = lastWallet.requested_at + cooldownSeconds;
    return res.status(429).json({
      error: "wallet_rate_limited",
      retryAt,
      retryAtPst: formatPst(retryAt),
    });
  }

  const lastIp = db
    .prepare(
      "SELECT requested_at FROM faucet_requests WHERE ip = ? ORDER BY requested_at DESC LIMIT 1"
    )
    .get(ip);
  if (lastIp && now < lastIp.requested_at + cooldownSeconds) {
    const retryAt = lastIp.requested_at + cooldownSeconds;
    return res.status(429).json({
      error: "ip_rate_limited",
      retryAt,
      retryAtPst: formatPst(retryAt),
    });
  }

  let payer;
  let mintKeypair;
  try {
    payer = getPayerKeypair();
    mintKeypair = getMintKeypair();
    if (!payer || !mintKeypair) {
      return res.status(500).json({ error: "faucet_not_configured" });
    }
  } catch (error) {
    return res.status(500).json({
      error: "faucet_keypair_error",
      message: error.message,
    });
  }

  try {
    const connection = new Connection(SOLANA_RPC_URL, "confirmed");
    const mint = mintKeypair.publicKey;
    const target = new PublicKey(wallet);

    const mintInfo = await connection.getAccountInfo(mint);
    if (!mintInfo) {
      await createMint(
        connection,
        payer,
        mintKeypair.publicKey,
        null,
        6,
        mintKeypair,
        undefined,
        TOKEN_PROGRAM_ID
      );
    }

    const ata = await createAssociatedTokenAccountIdempotent(
      connection,
      payer,
      mint,
      target,
      undefined,
      TOKEN_PROGRAM_ID,
      ASSOCIATED_TOKEN_PROGRAM_ID
    );

    const mintDetails = await getMint(connection, mint);
    const rawAmount = BigInt(Math.round(FAUCET_AMOUNT * 10 ** mintDetails.decimals));

    const sig = await mintToChecked(
      connection,
      payer,
      mint,
      ata,
      mintKeypair.publicKey,
      rawAmount,
      mintDetails.decimals,
      [mintKeypair],
      undefined,
      TOKEN_PROGRAM_ID
    );

    db.prepare(
      "INSERT INTO faucet_requests (wallet, ip, amount, network, requested_at, tx_sig) VALUES (?, ?, ?, ?, ?, ?)"
    ).run(wallet, ip, Number(rawAmount), network, now, sig);

    return res.json({
      ok: true,
      wallet,
      amount: FAUCET_AMOUNT,
      mint: mint.toBase58(),
      tokenAccount: ata.toBase58(),
      network,
      txSig: sig,
      nextAvailableAt: now + cooldownSeconds,
      nextAvailableAtPst: formatPst(now + cooldownSeconds),
    });
  } catch (error) {
    console.error("faucet error:", error);
    return res.status(500).json({ error: "faucet_failed", message: error.message });
  }
});

module.exports = router;

const fs = require("fs");
const path = require("path");
const {
  Connection,
  Keypair,
  PublicKey,
  LAMPORTS_PER_SOL,
} = require("@solana/web3.js");
const { createMint, getMinimumBalanceForRentExemptMint } = require("@solana/spl-token");
const {
  SOLANA_RPC_URL,
  FAUCET_MINT_KEYPAIR,
  FAUCET_PAYER_KEYPAIR,
  USDC_MINT,
} = require("../config");

const loadKeypair = (filePath) => {
  const resolved = path.resolve(filePath);
  if (!fs.existsSync(resolved)) {
    throw new Error(`keypair_not_found:${resolved}`);
  }
  const raw = JSON.parse(fs.readFileSync(resolved, "utf8"));
  return Keypair.fromSecretKey(Uint8Array.from(raw));
};

const getMintKeypair = () => {
  if (!FAUCET_MINT_KEYPAIR) {
    return null;
  }
  return loadKeypair(FAUCET_MINT_KEYPAIR);
};

const getPayerKeypair = () => {
  if (!FAUCET_PAYER_KEYPAIR) {
    return null;
  }
  return loadKeypair(FAUCET_PAYER_KEYPAIR);
};

const getMintPublicKey = () => {
  if (USDC_MINT) {
    return new PublicKey(USDC_MINT);
  }
  const mintKeypair = getMintKeypair();
  return mintKeypair ? mintKeypair.publicKey : null;
};

const ensureFaucetMint = async () => {
  const mintPubkey = getMintPublicKey();
  if (!mintPubkey) {
    return { ok: false, reason: "mint_not_configured" };
  }

  const connection = new Connection(SOLANA_RPC_URL, "confirmed");
  const mintAccount = await connection.getAccountInfo(mintPubkey);
  if (mintAccount) {
    return { ok: true, mint: mintPubkey, created: false };
  }

  if (USDC_MINT) {
    return { ok: false, reason: "mint_missing", mint: mintPubkey };
  }

  const payer = getPayerKeypair();
  const mintKeypair = getMintKeypair();
  if (!payer || !mintKeypair) {
    return { ok: false, reason: "mint_not_configured" };
  }

  const requiredLamports = await getMinimumBalanceForRentExemptMint(connection);
  const payerBalance = await connection.getBalance(payer.publicKey);
  if (payerBalance < requiredLamports) {
    return {
      ok: false,
      reason: "insufficient_funds",
      mint: mintPubkey,
      payer: payer.publicKey,
      balance: payerBalance,
      requiredLamports,
      requiredSol: requiredLamports / LAMPORTS_PER_SOL,
    };
  }

  await createMint(
    connection,
    payer,
    mintKeypair.publicKey,
    null,
    6,
    mintKeypair
  );

  return { ok: true, mint: mintPubkey, created: true };
};

module.exports = {
  loadKeypair,
  getMintKeypair,
  getPayerKeypair,
  getMintPublicKey,
  ensureFaucetMint,
};

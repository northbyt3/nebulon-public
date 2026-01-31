const path = require("path");

const PORT = Number(process.env.PORT || 3333);
const ROOT_DIR = path.join(__dirname, "..");
const defaultDb = path.join(ROOT_DIR, "data", "nebulon.db");
const envDb = process.env.DATABASE_URL;
const DATABASE_URL = envDb
  ? path.isAbsolute(envDb)
    ? envDb
    : path.join(ROOT_DIR, envDb)
  : defaultDb;
const JWT_SECRET = process.env.JWT_SECRET || "dev-secret-change";
const JWT_TTL = process.env.JWT_TTL || "7d";
const BASE_URL = process.env.BASE_URL || "http://174.138.42.117:3000";
const SOLANA_RPC_URL =
  process.env.SOLANA_RPC_URL ||
  process.env.ANCHOR_PROVIDER_URL ||
  "https://api.devnet.solana.com";
const SOLANA_WS_URL = process.env.SOLANA_WS_URL || "";
const SOLANA_NETWORK = (process.env.SOLANA_NETWORK || "").toLowerCase();
const EPHEMERAL_PROVIDER_ENDPOINT =
  process.env.EPHEMERAL_PROVIDER_ENDPOINT || "";
const EPHEMERAL_WS_ENDPOINT = process.env.EPHEMERAL_WS_ENDPOINT || "";
const EPHEMERAL_VALIDATOR_IDENTITY =
  process.env.EPHEMERAL_VALIDATOR_IDENTITY || "";
const EPHEMERAL_PERMISSION_ENDPOINT =
  process.env.EPHEMERAL_PERMISSION_ENDPOINT || "";
const EPHEMERAL_TEE_ENDPOINT = process.env.EPHEMERAL_TEE_ENDPOINT || "";
const EPHEMERAL_TEE_WS_ENDPOINT = process.env.EPHEMERAL_TEE_WS_ENDPOINT || "";
const PROGRAM_ID =
  process.env.PROGRAM_ID || "6UqkmQ2iCkf3acBB71DdXtVd49EyuaftMz8V3E74USbC";
const DELEGATION_PROGRAM_ID =
  process.env.DELEGATION_PROGRAM_ID ||
  "DELeGGvXpWV2fqJUhqcF5ZSYMS4JTLjteaAMARRSaeSh";
const DEFAULT_JUDGE =
  process.env.DEFAULT_JUDGE || "w8sdYr2sM1dfyD7vsTt6EXcQWQ1mfNWfQJMzQNNnUXq";
const INDEXER_INTERVAL_SECONDS = Number(
  process.env.INDEXER_INTERVAL_SECONDS || 20
);
const CHALLENGE_TTL_SECONDS = Number(process.env.CHALLENGE_TTL_SECONDS || 300);
const INVITE_TTL_DAYS = Number(process.env.INVITE_TTL_DAYS || 3);
const HANDLE_COOLDOWN_DAYS = Number(process.env.HANDLE_COOLDOWN_DAYS || 30);
const ADMIN_WALLETS = (process.env.ADMIN_WALLETS || "")
  .split(",")
  .map((entry) => entry.trim())
  .filter(Boolean);
const FAUCET_ENABLED = process.env.FAUCET_ENABLED === "true";
const FAUCET_AMOUNT = Number(process.env.FAUCET_AMOUNT || 200);
const FAUCET_COOLDOWN_HOURS = Number(process.env.FAUCET_COOLDOWN_HOURS || 12);
const FAUCET_ALLOWED_NETWORKS = (process.env.FAUCET_ALLOWED_NETWORKS || "")
  .split(",")
  .map((entry) => entry.trim().toLowerCase())
  .filter(Boolean);
const FAUCET_MINT_KEYPAIR = process.env.FAUCET_MINT_KEYPAIR || "";
const FAUCET_PAYER_KEYPAIR = process.env.FAUCET_PAYER_KEYPAIR || "";
const USDC_MINT = process.env.USDC_MINT || "";

module.exports = {
  PORT,
  ROOT_DIR,
  DATABASE_URL,
  JWT_SECRET,
  JWT_TTL,
  BASE_URL,
  SOLANA_RPC_URL,
  SOLANA_WS_URL,
  SOLANA_NETWORK,
  EPHEMERAL_PROVIDER_ENDPOINT,
  EPHEMERAL_WS_ENDPOINT,
  EPHEMERAL_VALIDATOR_IDENTITY,
  EPHEMERAL_PERMISSION_ENDPOINT,
  EPHEMERAL_TEE_ENDPOINT,
  EPHEMERAL_TEE_WS_ENDPOINT,
  PROGRAM_ID,
  DELEGATION_PROGRAM_ID,
  DEFAULT_JUDGE,
  INDEXER_INTERVAL_SECONDS,
  CHALLENGE_TTL_SECONDS,
  INVITE_TTL_DAYS,
  HANDLE_COOLDOWN_DAYS,
  ADMIN_WALLETS,
  FAUCET_ENABLED,
  FAUCET_AMOUNT,
  FAUCET_COOLDOWN_HOURS,
  FAUCET_ALLOWED_NETWORKS,
  FAUCET_MINT_KEYPAIR,
  FAUCET_PAYER_KEYPAIR,
  USDC_MINT,
};

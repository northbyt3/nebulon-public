const fs = require("fs");
const path = require("path");
const Database = require("better-sqlite3");
const { DATABASE_URL } = require("./config");
const { seedReservedWords } = require("./utils/reserved");

const ensureDir = (filePath) => {
  const dir = path.dirname(filePath);
  const exists = fs.existsSync(dir);
  if (exists) {
    console.log("Data Directory Exist : True");
  } else {
    console.log("Data Directory Exist : False (Creating...)");
    fs.mkdirSync(dir, { recursive: true });
  }
};

ensureDir(DATABASE_URL);

const db = new Database(DATABASE_URL);
db.pragma("journal_mode = WAL");

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  wallet TEXT NOT NULL UNIQUE,
  handle TEXT UNIQUE,
  user_pfp TEXT,
  role TEXT NOT NULL DEFAULT 'user',
  profile_initialized_at INTEGER,
  handle_changed_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS handle_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  wallet TEXT NOT NULL,
  old_handle TEXT,
  new_handle TEXT NOT NULL,
  changed_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS reserved_handles (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  word TEXT NOT NULL UNIQUE,
  reason TEXT,
  admin_only INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS auth_challenges (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  wallet TEXT NOT NULL,
  nonce TEXT NOT NULL,
  message TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  used_at INTEGER,
  created_at INTEGER NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_auth_challenges_wallet_nonce
  ON auth_challenges(wallet, nonce);

CREATE TABLE IF NOT EXISTS invites (
  id TEXT PRIMARY KEY,
  issuer_wallet TEXT NOT NULL,
  invitee_role TEXT NOT NULL,
  invitee_wallet TEXT,
  token_hash TEXT NOT NULL,
  status TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  accepted_by TEXT,
  accepted_at INTEGER,
  canceled_at INTEGER,
  contract_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_invites_status ON invites(status);
CREATE INDEX IF NOT EXISTS idx_invites_contract ON invites(contract_id);

CREATE TABLE IF NOT EXISTS contract_drafts (
  id TEXT PRIMARY KEY,
  issuer_wallet TEXT NOT NULL,
  client_wallet TEXT,
  contractor_wallet TEXT,
  status TEXT NOT NULL,
  execution_mode TEXT NOT NULL DEFAULT 'per',
  terms_hash TEXT,
  terms_encrypted TEXT,
  milestones_json TEXT,
  deadline INTEGER,
  total_payment TEXT,
  client_signed_at INTEGER,
  contractor_signed_at INTEGER,
  escrow_pda TEXT,
  mint TEXT,
  vault_token TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_contract_status ON contract_drafts(status);
CREATE INDEX IF NOT EXISTS idx_contract_client ON contract_drafts(client_wallet);
CREATE INDEX IF NOT EXISTS idx_contract_contractor ON contract_drafts(contractor_wallet);

CREATE TABLE IF NOT EXISTS contract_keys (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  contract_id TEXT NOT NULL,
  wallet TEXT NOT NULL,
  public_key TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(contract_id, wallet)
);

CREATE INDEX IF NOT EXISTS idx_contract_keys_contract ON contract_keys(contract_id);

CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  actor_wallet TEXT NOT NULL,
  action TEXT NOT NULL,
  target_type TEXT,
  target_id TEXT,
  details_json TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS faucet_requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  wallet TEXT NOT NULL,
  ip TEXT NOT NULL,
  amount INTEGER NOT NULL,
  network TEXT NOT NULL,
  requested_at INTEGER NOT NULL,
  tx_sig TEXT
);

CREATE INDEX IF NOT EXISTS idx_faucet_wallet ON faucet_requests(wallet);
CREATE INDEX IF NOT EXISTS idx_faucet_ip ON faucet_requests(ip);
CREATE INDEX IF NOT EXISTS idx_faucet_requested_at ON faucet_requests(requested_at);

CREATE TABLE IF NOT EXISTS ratings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  contract_id TEXT NOT NULL,
  rater_wallet TEXT NOT NULL,
  ratee_wallet TEXT NOT NULL,
  score INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE(contract_id, rater_wallet)
);

CREATE INDEX IF NOT EXISTS idx_ratings_ratee ON ratings(ratee_wallet);
CREATE INDEX IF NOT EXISTS idx_ratings_contract ON ratings(contract_id);
`);

const ensureInviteColumns = () => {
  const columns = db.prepare("PRAGMA table_info(invites)").all();
  const names = columns.map((column) => column.name);
  if (!names.includes("invitee_wallet")) {
    db.prepare("ALTER TABLE invites ADD COLUMN invitee_wallet TEXT").run();
  }
};

ensureInviteColumns();

const ensureUserColumns = () => {
  const columns = db.prepare("PRAGMA table_info(users)").all();
  const names = columns.map((column) => column.name);
  if (!names.includes("profile_initialized_at")) {
    db.prepare("ALTER TABLE users ADD COLUMN profile_initialized_at INTEGER").run();
  }
};

ensureUserColumns();

const ensureContractColumns = () => {
  const columns = db.prepare("PRAGMA table_info(contract_drafts)").all();
  const names = columns.map((column) => column.name);
  if (!names.includes("terms_encrypted")) {
    db.prepare("ALTER TABLE contract_drafts ADD COLUMN terms_encrypted TEXT").run();
  }
  if (!names.includes("execution_mode")) {
    db.prepare("ALTER TABLE contract_drafts ADD COLUMN execution_mode TEXT DEFAULT 'per'").run();
    db.prepare("UPDATE contract_drafts SET execution_mode = 'per' WHERE execution_mode IS NULL").run();
  }
};

ensureContractColumns();

db.exec("CREATE INDEX IF NOT EXISTS idx_invites_invitee_wallet ON invites(invitee_wallet);");

seedReservedWords(db);

const row = db.prepare("SELECT COUNT(*) as count FROM users").get();
const totalUsers = row ? row.count : 0;
console.log(
  `Accounts : ${totalUsers} (run with --show-users to show full list)`
);
console.log("Database initialized successfully");
console.log("");

module.exports = { db };

const fs = require("fs");
const path = require("path");
const { Keypair } = require("@solana/web3.js");
const { capsuleWalletsDir, capsuleRoot } = require("./paths");
const { getActiveCapsule } = require("./capsules");
const { resolveWalletPath } = require("./config");

const validateKeypairJson = (raw) => {
  if (!Array.isArray(raw) || raw.length < 32) {
    throw new Error("Invalid keypair JSON.");
  }
};

const writeKeypairFile = (targetPath, secretKey) => {
  fs.writeFileSync(targetPath, JSON.stringify(Array.from(secretKey)));
};

const generateWallet = (name) => {
  const keypair = Keypair.generate();
  const capsule = getActiveCapsule();
  const targetPath = path.join(capsuleWalletsDir(capsule), `${name}.json`);
  writeKeypairFile(targetPath, keypair.secretKey);
  return { keypair, path: targetPath };
};

const importWalletFromFile = (name, sourcePath) => {
  if (!fs.existsSync(sourcePath)) {
    throw new Error(`Wallet file not found: ${sourcePath}`);
  }
  const raw = JSON.parse(fs.readFileSync(sourcePath, "utf8"));
  validateKeypairJson(raw);
  const capsule = getActiveCapsule();
  const targetPath = path.join(capsuleWalletsDir(capsule), `${name}.json`);
  fs.writeFileSync(targetPath, JSON.stringify(raw));
  const keypair = Keypair.fromSecretKey(Uint8Array.from(raw));
  return { keypair, path: targetPath };
};

const listWallets = (config) => {
  return Object.entries(config.wallets || {}).map(([name, entry]) => ({
    name,
    entry,
    path: resolveWalletPath(entry),
    active: config.activeWallet === name,
  }));
};

const setActiveWallet = (config, name) => {
  if (!config.wallets || !config.wallets[name]) {
    throw new Error(`Wallet not found: ${name}`);
  }
  config.activeWallet = name;
};

const addWalletEntry = (config, name, walletPath) => {
  const capsule = getActiveCapsule();
  const baseDir = capsuleRoot(capsule);
  const relativePath = path.isAbsolute(walletPath)
    ? path.relative(baseDir, walletPath)
    : walletPath;
  config.wallets[name] = { path: relativePath };
};

const loadWalletKeypair = (config, name) => {
  const entry = config.wallets && config.wallets[name];
  if (!entry) {
    throw new Error(`Wallet not found: ${name}`);
  }
  const resolved = resolveWalletPath(entry);
  if (!resolved || !fs.existsSync(resolved)) {
    throw new Error(`Wallet file missing: ${resolved || entry.path}`);
  }
  const raw = JSON.parse(fs.readFileSync(resolved, "utf8"));
  validateKeypairJson(raw);
  return Keypair.fromSecretKey(Uint8Array.from(raw));
};

module.exports = {
  generateWallet,
  importWalletFromFile,
  listWallets,
  setActiveWallet,
  addWalletEntry,
  loadWalletKeypair,
};

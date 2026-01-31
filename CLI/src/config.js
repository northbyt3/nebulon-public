const fs = require("fs");
const path = require("path");
const { capsuleConfigPath, capsuleRoot } = require("./paths");
const { getActiveCapsule, ensureCapsuleDirs } = require("./capsules");
const { DEFAULT_CONFIG } = require("./constants");

const ensureDirs = (capsuleName) => {
  const capsule = getActiveCapsule(capsuleName);
  ensureCapsuleDirs(capsule);
};

const mergeDefaults = (config) => {
  return {
    ...DEFAULT_CONFIG,
    ...config,
    wallets: config.wallets || {},
    sessions: config.sessions || {},
    privacy: {
      ...(DEFAULT_CONFIG.privacy || {}),
      ...(config.privacy || {}),
      contractKeys: (config.privacy && config.privacy.contractKeys) || {},
    },
    auth: {
      ...DEFAULT_CONFIG.auth,
      ...(config.auth || {}),
    },
  };
};

const loadConfig = (capsuleName) => {
  const capsule = getActiveCapsule(capsuleName);
  ensureDirs(capsule);
  const filePath = capsuleConfigPath(capsule);
  if (!fs.existsSync(filePath)) {
    const initial = mergeDefaults({});
    fs.writeFileSync(filePath, JSON.stringify(initial, null, 2));
    return initial;
  }
  const raw = JSON.parse(fs.readFileSync(filePath, "utf8"));
  return mergeDefaults(raw);
};

const saveConfig = (config, capsuleName) => {
  const capsule = getActiveCapsule(capsuleName);
  ensureDirs(capsule);
  const filePath = capsuleConfigPath(capsule);
  fs.writeFileSync(filePath, JSON.stringify(config, null, 2));
};

const setNestedValue = (obj, key, value) => {
  const parts = key.split(".").filter(Boolean);
  let current = obj;
  for (let i = 0; i < parts.length - 1; i += 1) {
    const part = parts[i];
    if (!current[part] || typeof current[part] !== "object") {
      current[part] = {};
    }
    current = current[part];
  }
  current[parts[parts.length - 1]] = value;
};

const resolveWalletPath = (walletEntry, capsuleName) => {
  if (!walletEntry || !walletEntry.path) {
    return null;
  }
  const capsule = getActiveCapsule(capsuleName);
  const baseDir = capsuleRoot(capsule);
  return path.isAbsolute(walletEntry.path)
    ? walletEntry.path
    : path.join(baseDir, walletEntry.path);
};

module.exports = {
  ensureDirs,
  loadConfig,
  saveConfig,
  setNestedValue,
  resolveWalletPath,
};

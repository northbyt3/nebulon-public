const fs = require("fs");
const {
  nebulonHome,
  legacyConfigPath,
  legacyWalletsDir,
  capsulesDir,
  activeCapsulePath,
  capsuleRoot,
  capsuleConfigPath,
  capsuleWalletsDir,
} = require("./paths");

const CAPSULE_NAME_RE = /^[a-zA-Z0-9_-]+$/;

const ensureBaseDirs = () => {
  const home = nebulonHome();
  if (!fs.existsSync(home)) {
    fs.mkdirSync(home, { recursive: true });
  }
  const capsuleRootDir = capsulesDir();
  if (!fs.existsSync(capsuleRootDir)) {
    fs.mkdirSync(capsuleRootDir, { recursive: true });
  }
};

const readActiveState = () => {
  ensureBaseDirs();
  const statePath = activeCapsulePath();
  if (!fs.existsSync(statePath)) {
    return { lastUsed: null, sessions: {} };
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(statePath, "utf8"));
    return {
      lastUsed: parsed.lastUsed || null,
      sessions: parsed.sessions || {},
    };
  } catch (error) {
    return { lastUsed: null, sessions: {} };
  }
};

const writeActiveState = (state) => {
  ensureBaseDirs();
  fs.writeFileSync(activeCapsulePath(), JSON.stringify(state, null, 2));
};

const getSessionId = () => String(process.ppid || process.pid);

const isValidCapsuleName = (name) =>
  typeof name === "string" && CAPSULE_NAME_RE.test(name.trim());

const ensureCapsuleDirs = (name) => {
  ensureBaseDirs();
  const root = capsuleRoot(name);
  if (!fs.existsSync(root)) {
    fs.mkdirSync(root, { recursive: true });
  }
  const wallets = capsuleWalletsDir(name);
  if (!fs.existsSync(wallets)) {
    fs.mkdirSync(wallets, { recursive: true });
  }
};

const listCapsules = () => {
  ensureBaseDirs();
  const root = capsulesDir();
  if (!fs.existsSync(root)) {
    return [];
  }
  return fs
    .readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b));
};

const migrateLegacyIfNeeded = () => {
  if (!fs.existsSync(legacyConfigPath())) {
    return false;
  }
  if (listCapsules().length > 0) {
    return false;
  }
  ensureCapsuleDirs("1");
  try {
    fs.renameSync(legacyConfigPath(), capsuleConfigPath("1"));
  } catch (error) {
    fs.copyFileSync(legacyConfigPath(), capsuleConfigPath("1"));
    fs.rmSync(legacyConfigPath(), { force: true });
  }
  if (fs.existsSync(legacyWalletsDir())) {
    try {
      fs.renameSync(legacyWalletsDir(), capsuleWalletsDir("1"));
    } catch (error) {
      fs.cpSync(legacyWalletsDir(), capsuleWalletsDir("1"), {
        recursive: true,
      });
      fs.rmSync(legacyWalletsDir(), { recursive: true, force: true });
    }
  }
  const state = readActiveState();
  state.lastUsed = "1";
  state.sessions[getSessionId()] = "1";
  writeActiveState(state);
  return true;
};

const getActiveCapsule = (preferred) => {
  migrateLegacyIfNeeded();
  const state = readActiveState();
  const sessionId = getSessionId();
  let capsule =
    (preferred && preferred.trim()) ||
    state.sessions[sessionId] ||
    state.lastUsed ||
    "1";
  if (!isValidCapsuleName(capsule)) {
    capsule = "1";
  }
  ensureCapsuleDirs(capsule);
  if (state.sessions[sessionId] !== capsule || state.lastUsed !== capsule) {
    state.sessions[sessionId] = capsule;
    state.lastUsed = capsule;
    writeActiveState(state);
  }
  return capsule;
};

const setActiveCapsule = (name) => {
  if (!isValidCapsuleName(name)) {
    throw new Error(
      "Invalid capsule name. Use letters, numbers, dashes, or underscores."
    );
  }
  ensureCapsuleDirs(name.trim());
  const state = readActiveState();
  const sessionId = getSessionId();
  state.sessions[sessionId] = name.trim();
  state.lastUsed = name.trim();
  writeActiveState(state);
  return name.trim();
};

module.exports = {
  ensureCapsuleDirs,
  getActiveCapsule,
  isValidCapsuleName,
  listCapsules,
  migrateLegacyIfNeeded,
  readActiveState,
  setActiveCapsule,
  writeActiveState,
};

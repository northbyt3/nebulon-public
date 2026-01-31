const { loadWalletKeypair } = require("./wallets");
const { saveConfig } = require("./config");
const { getChallenge, signChallenge, verify, me } = require("./hosted");

const REFRESH_INTERVAL_SECONDS = 15 * 60;

const nowSeconds = () => Math.floor(Date.now() / 1000);

const base64UrlDecode = (value) => {
  if (!value) {
    return null;
  }
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded =
    normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
  return Buffer.from(padded, "base64").toString("utf8");
};

const decodeJwt = (token) => {
  if (!token) {
    return null;
  }
  const parts = token.split(".");
  if (parts.length !== 3) {
    return null;
  }
  try {
    const payload = base64UrlDecode(parts[1]);
    return JSON.parse(payload);
  } catch (error) {
    return null;
  }
};

const ensureAuthState = (config) => {
  if (!config.auth) {
    config.auth = {
      token: null,
      wallet: null,
      handle: null,
      role: null,
      lastAuthAt: null,
    };
  }
};

const recordAuth = (config, result) => {
  config.auth.token = result.token;
  config.auth.wallet = result.user.wallet;
  config.auth.handle = result.user.handle || null;
  config.auth.role = result.user.role || null;
  config.auth.lastAuthAt = nowSeconds();
};

const shouldRefresh = (config) => {
  if (!config.auth.token) {
    return true;
  }
  const now = nowSeconds();
  if (config.auth.lastAuthAt && now - config.auth.lastAuthAt >= REFRESH_INTERVAL_SECONDS) {
    return true;
  }
  const tokenData = decodeJwt(config.auth.token);
  if (tokenData && tokenData.exp && tokenData.exp - now <= 60) {
    return true;
  }
  return false;
};

const refreshSession = async (config, options = {}) => {
  const keypair = loadWalletKeypair(config, config.activeWallet);
  const wallet = keypair.publicKey.toBase58();
  if (!options.quiet) {
    console.log("Refreshing session...");
  }
  const challenge = await getChallenge(config.backendUrl, wallet);
  const signature = signChallenge(keypair, challenge.message);
  const result = await verify(config.backendUrl, {
    wallet,
    nonce: challenge.nonce,
    signature,
  });
  recordAuth(config, result);
  saveConfig(config);
  return result;
};

const ensureHostedSession = async (config, options = {}) => {
  if (config.mode !== "hosted") {
    throw new Error("Hosted mode required.");
  }
  if (!config.activeWallet) {
    throw new Error("No active wallet. Run: nebulon init");
  }

  ensureAuthState(config);
  if (!config.auth.lastAuthAt && config.auth.token) {
    const tokenData = decodeJwt(config.auth.token);
    if (tokenData && tokenData.iat) {
      config.auth.lastAuthAt = tokenData.iat;
    }
  }

  if (shouldRefresh(config)) {
    await refreshSession(config, options);
  }

  if (options.requireHandle) {
    let handle = config.auth.handle;
    if (!handle && config.auth.token) {
      try {
        const profile = await me(config.backendUrl, config.auth.token);
        handle = profile.nebulonId || profile.handle || null;
        config.auth.handle = handle;
        saveConfig(config);
      } catch (error) {
        // ignore and fallback to error below
      }
    }
    if (!handle) {
      throw new Error("Nebulon ID required. Run: nebulon login");
    }
  }

  return config;
};

module.exports = {
  ensureHostedSession,
  decodeJwt,
};

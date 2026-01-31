const { PublicKey } = require("@solana/web3.js");
const chalk = require("chalk");
const { loadConfig, saveConfig, setNestedValue } = require("../config");
const { getActiveCapsule } = require("../capsules");
const { NETWORK_PRESETS } = require("../constants");
const { getConfig: getHostedConfig, me } = require("../hosted");
const { loadWalletKeypair } = require("../wallets");
const { keyValue } = require("../ui");

const sourceLabel = (source, backendSource) => {
  if (!source || source === "custom") {
    return "custom";
  }
  if (source === "backend") {
    return backendSource === "custom" ? "custom" : "auto";
  }
  if (source === "official") {
    return "auto";
  }
  return "auto";
};

const tag = (value) => chalk.gray(`(${value})`);

const backendLabel = (config) => {
  if (config.backendSource) {
    return config.backendSource;
  }
  if (config.backendUrl === "http://174.138.42.117:3333") {
    return "official";
  }
  return "custom";
};

const printConfigSummary = async (config) => {
  console.log("NEBULON - Configuration");
  console.log("");
  keyValue("Capsule", getActiveCapsule());
  keyValue("Mode", `${config.mode} ${tag(backendLabel(config))}`);

  let statusValue = "n/a";
  let profile = null;
  if (config.mode === "hosted") {
    if (config.auth && config.auth.token) {
      try {
        profile = await me(config.backendUrl, config.auth.token);
        statusValue = "Connected To Server";
      } catch (error) {
        statusValue = "Disconnected From Server";
      }
    } else {
      statusValue = "Disconnected From Server";
    }
  }
  keyValue("Status", statusValue);

  const nebHandle =
    (profile && (profile.nebulonId || profile.handle)) ||
    (config.auth && config.auth.handle) ||
    "none";
  keyValue("NebulonID", config.mode === "hosted" ? nebHandle : "n/a");

  if (config.activeWallet) {
    try {
      const keypair = loadWalletKeypair(config, config.activeWallet);
      keyValue(
        "Wallet",
        `${config.activeWallet} (${keypair.publicKey.toBase58()})`
      );
    } catch (error) {
      keyValue("Wallet", config.activeWallet);
    }
  } else {
    keyValue("Wallet", "none");
  }

  console.log("");
  console.log("Server Settings");
  keyValue(
    "Server URL",
    config.mode === "hosted"
      ? `${config.backendUrl} ${tag(backendLabel(config))}`
      : "n/a"
  );
  keyValue(
    "Network",
    `${config.network} ${tag(sourceLabel(config.networkSource, config.backendSource))}`
  );
  if (config.ephemeralProviderUrl) {
    keyValue(
      "MagicBlock RPC URL",
      `${config.ephemeralProviderUrl} ${tag(sourceLabel(config.ephemeralProviderUrlSource, config.backendSource))}`
    );
  }
  if (config.ephemeralWsUrl) {
    keyValue(
      "MagicBlock WebSocket URL",
      `${config.ephemeralWsUrl} ${tag(sourceLabel(config.ephemeralWsUrlSource, config.backendSource))}`
    );
  }
  if (config.ephemeralValidatorIdentity) {
    keyValue(
      "MagicBlock Validator Identity",
      `${config.ephemeralValidatorIdentity} ${tag(sourceLabel(config.ephemeralValidatorIdentitySource, config.backendSource))}`
    );
  }
  if (config.ephemeralPermissionEndpoint) {
    keyValue(
      "MagicBlock Permission Endpoint",
      `${config.ephemeralPermissionEndpoint} ${tag(sourceLabel(config.ephemeralPermissionEndpointSource, config.backendSource))}`
    );
  }
  if (config.ephemeralTeeEndpoint) {
    keyValue(
      "MagicBlock TEE Endpoint",
      `${config.ephemeralTeeEndpoint} ${tag(sourceLabel(config.ephemeralTeeEndpointSource, config.backendSource))}`
    );
  }
  if (config.ephemeralTeeWsEndpoint) {
    keyValue(
      "MagicBlock TEE WS Endpoint",
      `${config.ephemeralTeeWsEndpoint} ${tag(sourceLabel(config.ephemeralTeeWsEndpointSource, config.backendSource))}`
    );
  }
  keyValue(
    "Solana JSON RPC URL",
    `${config.rpcUrl} ${tag(sourceLabel(config.rpcUrlSource, config.backendSource))}`
  );
  keyValue(
    "Solana WebSocket URL",
    `${config.wsUrl} ${tag(sourceLabel(config.wsUrlSource, config.backendSource))}`
  );

  console.log("");
  console.log("Web3 Settings");
  keyValue(
    "Program ID",
    `${config.programId} ${tag(sourceLabel(config.programIdSource, config.backendSource))}`
  );
  keyValue(
    "USDC mint address:",
    `${config.usdcMint} ${tag(sourceLabel(config.usdcMintSource, config.backendSource))}`
  );
  console.log("");
};

const isValidUrl = (value, protocols) => {
  try {
    const url = new URL(value);
    if (protocols && !protocols.includes(url.protocol)) {
      return false;
    }
    return true;
  } catch (error) {
    return false;
  }
};

const isValidPubkey = (value) => {
  try {
    // eslint-disable-next-line no-new
    new PublicKey(value);
    return true;
  } catch (error) {
    return false;
  }
};

const applyNetworkPreset = (config, network) => {
  const preset = NETWORK_PRESETS[network];
  if (!preset) {
    config.network = network;
    return;
  }
  config.network = network;
  config.rpcUrl = preset.rpcUrl;
  config.wsUrl = preset.wsUrl;
  config.usdcMint = preset.usdcMint;
  config.rpcUrlSource = "official";
  config.wsUrlSource = "official";
  config.usdcMintSource = "official";
};

const maybeRefreshFromBackend = async (config) => {
  if (config.mode !== "hosted" || !config.backendUrl) {
    return false;
  }
  try {
    const backendConfig = await getHostedConfig(config.backendUrl);
    if (backendConfig.programId && config.programIdSource === "backend") {
      config.programId = backendConfig.programId;
    }
    if (backendConfig.usdcMint && config.usdcMintSource === "backend") {
      config.usdcMint = backendConfig.usdcMint;
    }
    if (backendConfig.rpcUrl && config.rpcUrlSource === "backend") {
      config.rpcUrl = backendConfig.rpcUrl;
    }
    if (backendConfig.wsUrl && config.wsUrlSource === "backend") {
      config.wsUrl = backendConfig.wsUrl;
    }
    if (
      backendConfig.ephemeralProviderUrl &&
      config.ephemeralProviderUrlSource === "backend"
    ) {
      config.ephemeralProviderUrl = backendConfig.ephemeralProviderUrl;
    }
    if (
      backendConfig.ephemeralWsUrl &&
      config.ephemeralWsUrlSource === "backend"
    ) {
      config.ephemeralWsUrl = backendConfig.ephemeralWsUrl;
    }
    if (
      backendConfig.ephemeralValidatorIdentity &&
      config.ephemeralValidatorIdentitySource === "backend"
    ) {
      config.ephemeralValidatorIdentity = backendConfig.ephemeralValidatorIdentity;
    }
    if (
      backendConfig.ephemeralPermissionEndpoint &&
      config.ephemeralPermissionEndpointSource === "backend"
    ) {
      config.ephemeralPermissionEndpoint = backendConfig.ephemeralPermissionEndpoint;
    }
    if (
      backendConfig.ephemeralTeeEndpoint &&
      config.ephemeralTeeEndpointSource === "backend"
    ) {
      config.ephemeralTeeEndpoint = backendConfig.ephemeralTeeEndpoint;
    }
    if (
      backendConfig.ephemeralTeeWsEndpoint &&
      config.ephemeralTeeWsEndpointSource === "backend"
    ) {
      config.ephemeralTeeWsEndpoint = backendConfig.ephemeralTeeWsEndpoint;
    }
    if (backendConfig.network && config.networkSource === "backend") {
      config.network = backendConfig.network;
    }
    return true;
  } catch (error) {
    return false;
  }
};

const setConfigValue = async (config, key, value) => {
  if (key === "mode") {
    if (!["hosted", "direct"].includes(value)) {
      throw new Error("Mode must be hosted or direct.");
    }
    config.mode = value;
    return;
  }

  if (key === "network") {
    if (!["localnet", "devnet", "mainnet", "custom"].includes(value)) {
      throw new Error("Network must be localnet, devnet, mainnet, or custom.");
    }
    applyNetworkPreset(config, value);
    config.networkSource = "custom";
    return;
  }

  if (key === "rpcUrl") {
    if (!isValidUrl(value, ["http:", "https:"])) {
      throw new Error("Invalid RPC URL.");
    }
    config.rpcUrl = value;
    config.rpcUrlSource = "custom";
    return;
  }

  if (key === "wsUrl") {
    if (!isValidUrl(value, ["ws:", "wss:"])) {
      throw new Error("Invalid WebSocket URL.");
    }
    config.wsUrl = value;
    config.wsUrlSource = "custom";
    return;
  }

  if (key === "backendUrl") {
    if (!isValidUrl(value, ["http:", "https:"])) {
      throw new Error("Invalid backend URL.");
    }
    config.backendUrl = value;
    config.backendSource =
      value === "http://174.138.42.117:3333" ? "official" : "custom";
    await maybeRefreshFromBackend(config);
    return;
  }

  if (key === "ephemeralProviderUrl") {
    if (!isValidUrl(value, ["http:", "https:"])) {
      throw new Error("Invalid MagicBlock RPC URL.");
    }
    config.ephemeralProviderUrl = value;
    config.ephemeralProviderUrlSource = "custom";
    return;
  }

  if (key === "ephemeralWsUrl") {
    if (!isValidUrl(value, ["ws:", "wss:"])) {
      throw new Error("Invalid MagicBlock WebSocket URL.");
    }
    config.ephemeralWsUrl = value;
    config.ephemeralWsUrlSource = "custom";
    return;
  }

  if (key === "ephemeralValidatorIdentity") {
    if (!isValidPubkey(value)) {
      throw new Error("Invalid MagicBlock validator identity.");
    }
    config.ephemeralValidatorIdentity = value;
    config.ephemeralValidatorIdentitySource = "custom";
    return;
  }

  if (key === "ephemeralPermissionEndpoint") {
    if (!isValidUrl(value, ["http:", "https:"])) {
      throw new Error("Invalid MagicBlock permission endpoint.");
    }
    config.ephemeralPermissionEndpoint = value;
    config.ephemeralPermissionEndpointSource = "custom";
    return;
  }

  if (key === "ephemeralTeeEndpoint") {
    if (!isValidUrl(value, ["http:", "https:"])) {
      throw new Error("Invalid MagicBlock TEE endpoint.");
    }
    config.ephemeralTeeEndpoint = value;
    config.ephemeralTeeEndpointSource = "custom";
    return;
  }

  if (key === "ephemeralTeeWsEndpoint") {
    if (!isValidUrl(value, ["ws:", "wss:"])) {
      throw new Error("Invalid MagicBlock TEE WS endpoint.");
    }
    config.ephemeralTeeWsEndpoint = value;
    config.ephemeralTeeWsEndpointSource = "custom";
    return;
  }

  if (key === "programIdSource") {
    if (!["backend", "custom"].includes(value)) {
      throw new Error("Program ID source must be backend or custom.");
    }
    config.programIdSource = value;
    if (value === "backend") {
      const refreshed = await maybeRefreshFromBackend(config);
      if (!refreshed) {
        throw new Error("Unable to fetch backend config.");
      }
    }
    return;
  }

  if (key === "usdcMintSource") {
    if (!["backend", "custom"].includes(value)) {
      throw new Error("Test-USDC mint source must be backend or custom.");
    }
    config.usdcMintSource = value;
    if (value === "backend") {
      const refreshed = await maybeRefreshFromBackend(config);
      if (!refreshed) {
        throw new Error("Unable to fetch backend config.");
      }
    }
    return;
  }

  if (key === "programId") {
    if (!isValidPubkey(value)) {
      throw new Error("Invalid program ID.");
    }
    config.programId = value;
    config.programIdSource = "custom";
    return;
  }

  if (key === "usdcMint") {
    if (!isValidPubkey(value)) {
      throw new Error("Invalid mint address.");
    }
    config.usdcMint = value;
    config.usdcMintSource = "custom";
    return;
  }

  if (key === "activeWallet") {
    if (!config.wallets || !config.wallets[value]) {
      throw new Error("Wallet not found.");
    }
    config.activeWallet = value;
    return;
  }

  setNestedValue(config, key, value);
};

const runConfigGet = (key) => {
  const config = loadConfig();
  const parts = key.split(".").filter(Boolean);
  let current = config;
  for (const part of parts) {
    if (current && Object.prototype.hasOwnProperty.call(current, part)) {
      current = current[part];
    } else {
      current = undefined;
      break;
    }
  }
  if (typeof current === "undefined") {
    console.log("not found");
  } else {
    console.log(current);
  }
};

const runConfigSet = async (key, value) => {
  const config = loadConfig();
  try {
    await setConfigValue(config, key, value);
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
  saveConfig(config);
  console.log("Updated.");
};

const runConfigSummary = async () => {
  const config = loadConfig();
  await printConfigSummary(config);
};

module.exports = {
  runConfigGet,
  runConfigSet,
  runConfigSummary,
};

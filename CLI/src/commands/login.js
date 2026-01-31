const { prompt } = require("enquirer");
const chalk = require("chalk");
const { loadConfig, saveConfig } = require("../config");
const { successMessage } = require("../ui");
const { loadWalletKeypair } = require("../wallets");
const { getChallenge, signChallenge, verify, me, checkHandle, updateHandle } = require("../hosted");

const HANDLE_REGEX = /^[a-z0-9._-]+$/;
const PFP_CHOICES = [
  { name: "1 - galaxy", message: "1 - galaxy", value: "1" },
  { name: "2 - alien", message: "2 - alien", value: "2" },
  { name: "3 - star", message: "3 - star", value: "3" },
  { name: "4 - moon", message: "4 - moon", value: "4" },
  { name: "5 - spaceship", message: "5 - spaceship", value: "5" },
  { name: "6 - glyph", message: "6 - glyph", value: "6" },
  { name: "7 - saturn", message: "7 - saturn", value: "7" },
  { name: "8 - singularity", message: "8 - singularity", value: "8" },
];

const isPromptCancel = (error) => {
  if (!error) {
    return true;
  }
  if (typeof error === "string") {
    return error.trim() === "";
  }
  const message = (error.message || "").toLowerCase();
  return (
    message.includes("cancel") ||
    message.includes("aborted") ||
    message.includes("terminated")
  );
};

const nowSeconds = () => Math.floor(Date.now() / 1000);

const normalizeHandle = (value) =>
  value.trim().toLowerCase().replace(/^@/, "");

const validateHandleLocally = (handle) => {
  if (!handle) {
    return { ok: false, reason: "missing" };
  }
  if (handle.length < 4 || handle.length > 16) {
    return { ok: false, reason: "length" };
  }
  if (!HANDLE_REGEX.test(handle)) {
    return { ok: false, reason: "characters" };
  }
  if (handle.startsWith(".") || handle.endsWith(".")) {
    return { ok: false, reason: "dots" };
  }
  if (handle.includes("..")) {
    return { ok: false, reason: "dots" };
  }
  return { ok: true, value: handle };
};

const handleReasonMessage = (reason) => {
  switch (reason) {
    case "missing":
      return "ID is required.";
    case "length":
      return "Must be 4-16 characters.";
    case "characters":
      return "Only letters, numbers, dots, underscores, and hyphens.";
    case "dots":
      return "Cannot start/end with dots or have consecutive dots.";
    case "taken":
      return "This ID is already taken.";
    case "reserved":
      return "This ID is reserved.";
    case "error":
      return "Error checking availability.";
    default:
      return "Invalid Nebulon ID.";
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

const clearAuthState = (config) => {
  config.auth = {
    token: null,
    wallet: null,
    handle: null,
    role: null,
    lastAuthAt: null,
  };
};

const validateHandleAvailability = async (baseUrl, handle) => {
  const local = validateHandleLocally(handle);
  if (!local.ok) {
    return { ok: false, reason: local.reason };
  }
  const remote = await checkHandle(baseUrl, handle);
  if (!remote.available) {
    return { ok: false, reason: remote.reason || "taken" };
  }
  return { ok: true };
};

const promptForHandle = async (baseUrl) => {
  const answer = await prompt({
    type: "input",
    name: "handle",
    message: "Nebulon ID (optional)",
    hint: "Leave blank to auto-generate",
    validate: async (value) => {
      const normalized = normalizeHandle(value || "");
      if (!normalized) {
        return true;
      }
      try {
        const validation = await validateHandleAvailability(baseUrl, normalized);
        if (!validation.ok) {
          return handleReasonMessage(validation.reason);
        }
      } catch (error) {
        return handleReasonMessage("error");
      }
      return true;
    },
  });
  const normalized = normalizeHandle(answer.handle || "");
  return normalized || null;
};

const promptForPfp = async () => {
  const answer = await prompt({
    type: "select",
    name: "pfp",
    message: "Select profile picture",
    choices: PFP_CHOICES,
  });
  if (!answer.pfp) {
    return null;
  }
  return answer.pfp.endsWith(".png") ? answer.pfp : `${answer.pfp}.png`;
};

const dumpActiveHandles = () => {
  if (typeof process._getActiveHandles !== "function") {
    return;
  }
  const handles = process._getActiveHandles();
  const requests =
    typeof process._getActiveRequests === "function"
      ? process._getActiveRequests()
      : [];

  const summarize = (item) => {
    if (!item) {
      return "unknown";
    }
    if (item.constructor && item.constructor.name) {
      return item.constructor.name;
    }
    return typeof item;
  };

  console.log("Debug: active handles:", handles.map(summarize).join(", "));
  if (requests.length) {
    console.log(
      "Debug: active requests:",
      requests.map(summarize).join(", ")
    );
  }
  console.log(
    `Debug: stdin paused=${process.stdin.isPaused()} readable=${process.stdin.readable}`
  );
};

const finalizeLogin = (debug, exitCode = 0) => {
  if (debug) {
    dumpActiveHandles();
  }
  if (process.stdin.isTTY) {
    try {
      process.stdin.setRawMode(false);
    } catch (error) {
      // ignore
    }
    process.stdin.pause();
  }
  process.exit(exitCode);
};

const runLogin = async (options = {}) => {
  const debug = Boolean(options.debug);
  const config = loadConfig();
  if (config.mode !== "hosted") {
    console.log("Direct mode does not use hosted login.");
    return;
  }
  if (!config.activeWallet) {
    console.error("No active wallet. Run: nebulon init");
    process.exit(1);
  }
  ensureAuthState(config);
  const keypair = loadWalletKeypair(config, config.activeWallet);
  const wallet = keypair.publicKey.toBase58();

  try {
    if (config.auth.token) {
      try {
        const profile = await me(config.backendUrl, config.auth.token);
        config.auth.wallet = profile.wallet;
        config.auth.handle = profile.nebulonId || profile.handle || null;
        config.auth.role = profile.role || null;
      } catch (error) {
        clearAuthState(config);
      }
    }

    console.log("Requesting challenge...");
    const challenge = await getChallenge(config.backendUrl, wallet);
    if (debug) {
      console.log("Debug: challenge nonce", challenge.nonce);
    }

    console.log("Signing challenge...");
    const signature = signChallenge(keypair, challenge.message);
    if (debug) {
      console.log("Debug: signature length", signature.length);
    }
    const result = await verify(config.backendUrl, {
      wallet,
      nonce: challenge.nonce,
      signature,
    });
    if (debug) {
      console.log("Debug: verify user", result.user);
    }

    config.auth.token = result.token;
    config.auth.wallet = result.user.wallet;
    config.auth.handle = result.user.handle || null;
    config.auth.role = result.user.role || null;
    config.auth.lastAuthAt = nowSeconds();
    saveConfig(config);

    if (!config.auth.handle) {
      console.log("First-time setup detected.");
      console.log(
        "Choose a Nebulon ID (leave blank to auto-generate) and a profile picture."
      );
      let desiredHandle = options.handle ? normalizeHandle(options.handle) : null;
      if (options.handle) {
        const validation = await validateHandleAvailability(
          config.backendUrl,
          desiredHandle
        );
        if (!validation.ok) {
          console.error(`Handle invalid: ${handleReasonMessage(validation.reason)}`);
          process.exit(1);
        }
      } else {
        try {
          desiredHandle = await promptForHandle(config.backendUrl);
        } catch (error) {
          if (isPromptCancel(error)) {
            console.log("Login canceled - no changes applied.");
            return;
          }
          throw error;
        }
      }

      let pfpChoice = null;
      try {
        pfpChoice = await promptForPfp();
      } catch (error) {
        if (isPromptCancel(error)) {
          console.log("Login canceled - no changes applied.");
          return;
        }
        throw error;
      }

      if (debug) {
        console.log("Debug: handle update payload", {
          handle: desiredHandle || null,
          pfp: pfpChoice || null,
        });
      }
      const update = await updateHandle(
        config.backendUrl,
        config.auth.token,
        desiredHandle,
        pfpChoice
      );
      if (debug) {
        console.log("Debug: handle update response", update);
      }
      config.auth.handle = update.handle || desiredHandle;
      saveConfig(config);
    }

    successMessage("Login successful.");
    finalizeLogin(debug, 0);
  } catch (error) {
    throw new Error(error && error.message ? error.message : "Login failed.");
  }
};

module.exports = {
  runLogin,
};

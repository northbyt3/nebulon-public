const fs = require("fs");
const path = require("path");
const { prompt } = require("enquirer");
const chalk = require("chalk");
const { loadConfig, saveConfig } = require("../config");
const { getActiveCapsule, setActiveCapsule } = require("../capsules");
const { capsuleWalletsDir } = require("../paths");
const { NETWORK_PRESETS, PROGRAM_ID_DEFAULT } = require("../constants");
const { getConfig } = require("../hosted");
const {
  addWalletEntry,
  generateWallet,
  importWalletFromFile,
  setActiveWallet,
} = require("../wallets");
const { banner, successMessage } = require("../ui");

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

const ensureFileExists = (value) => {
  const trimmed = value.trim();
  if (!trimmed || !fs.existsSync(trimmed)) {
    return "File not found.";
  }
  return true;
};

const promptForNetwork = async (current) => {
  const networkAnswer = await prompt({
    type: "select",
    name: "network",
    message: "Select network",
    initial: current,
    choices: [
      { name: "localnet", message: "localnet" },
      { name: "devnet", message: "devnet" },
      { name: "mainnet", message: "mainnet" },
      { name: "custom", message: "custom" },
    ],
  });
  return networkAnswer.network;
};

const listImportOptions = (importDir) => {
  if (!importDir) {
    return [];
  }
  if (!fs.existsSync(importDir)) {
    fs.mkdirSync(importDir, { recursive: true });
  }
  return fs
    .readdirSync(importDir)
    .filter((file) => file.endsWith(".json"))
    .map((file) => ({
      name: file,
      message: file,
      value: path.join(importDir, file),
    }));
};

const promptForWallet = async (config) => {
  const importDir = path.join("C:\\", "Nebulon", "Wallets");
  const capsule = getActiveCapsule();
  const capsuleWalletDir = capsuleWalletsDir(capsule);

  while (true) {
    const walletAnswer = await prompt({
      type: "select",
      name: "walletAction",
      message: "Wallet setup",
      choices: [
        { name: "generate", message: "Generate new wallet" },
        { name: "import", message: "Import keypair file" },
      ],
    });

    if (walletAnswer.walletAction === "generate") {
      return { action: "generate", name: "default" };
    }

    const importChoices = listImportOptions(importDir);
    if (!importChoices.length) {
      console.log(`No wallet files found in ${importDir}.`);
      continue;
    }
    const importAnswer = await prompt({
      type: "select",
      name: "walletPath",
      message: `Select keypair file (${importDir})`,
      choices: [...importChoices, { name: "back", message: "Back", value: "back" }],
    });

    if (importAnswer.walletPath === "back") {
      continue;
    }

    const resolvedPath = path.isAbsolute(importAnswer.walletPath)
      ? importAnswer.walletPath
      : path.join(importDir, importAnswer.walletPath);
    return {
      action: "import",
      name: "default",
      path: path.resolve(resolvedPath),
    };
  }
};

const runInit = async (options = {}, capsuleName) => {
  try {
    if (!options.noBanner) {
      banner();
    }
    if (capsuleName) {
      try {
        setActiveCapsule(capsuleName);
      } catch (error) {
        console.error(error.message);
        process.exit(1);
      }
    }
    const config = loadConfig();

    const modeAnswer = { mode: "hosted" };

    let backendAnswer = { backendUrl: config.backendUrl };
    let backendSource = config.backendSource || "custom";
    let backendNetwork = null;
    let serverChoice = null;
    try {
      await getConfig((config.backendUrl || "http://localhost:3333").trim());
      serverChoice = await prompt({
        type: "select",
        name: "server",
        message: "Use official server or custom?",
        choices: [
          { name: "official", message: "Official server" },
          { name: "custom", message: "Custom server" },
        ],
      });
    } catch (error) {
      serverChoice = { server: "custom" };
    }

    if (serverChoice.server === "custom") {
      backendAnswer = await prompt({
        type: "input",
        name: "backendUrl",
        message: "Backend server URL",
        initial: config.backendUrl,
      });
      backendSource = "custom";
    } else {
      backendAnswer = { backendUrl: "http://localhost:3333" };
      backendSource = "official";
    }

    let programId = config.programId || PROGRAM_ID_DEFAULT;
    let usdcMint = config.usdcMint;
    let rpcUrl = config.rpcUrl;
    let wsUrl = config.wsUrl;
    let ephemeralProviderUrl = config.ephemeralProviderUrl || "";
    let ephemeralWsUrl = config.ephemeralWsUrl || "";
    let ephemeralValidatorIdentity = config.ephemeralValidatorIdentity || "";
    let ephemeralPermissionEndpoint = config.ephemeralPermissionEndpoint || "";
    let ephemeralTeeEndpoint = config.ephemeralTeeEndpoint || "";
    let ephemeralTeeWsEndpoint = config.ephemeralTeeWsEndpoint || "";
    let programIdSource = "custom";
    let usdcMintSource = "custom";
    let rpcUrlSource = config.rpcUrlSource || "custom";
    let wsUrlSource = config.wsUrlSource || "custom";
    let ephemeralProviderUrlSource =
      config.ephemeralProviderUrlSource || "custom";
    let ephemeralWsUrlSource = config.ephemeralWsUrlSource || "custom";
    let ephemeralValidatorIdentitySource =
      config.ephemeralValidatorIdentitySource || "custom";
    let ephemeralPermissionEndpointSource =
      config.ephemeralPermissionEndpointSource || "custom";
    let ephemeralTeeEndpointSource =
      config.ephemeralTeeEndpointSource || "custom";
    let ephemeralTeeWsEndpointSource =
      config.ephemeralTeeWsEndpointSource || "custom";
    let networkSource = config.networkSource || "custom";

    if (modeAnswer.mode === "hosted") {
      let backendConfig = null;
      try {
        backendConfig = await getConfig(backendAnswer.backendUrl.trim());
      } catch (error) {
        backendConfig = null;
      }
      if (!backendConfig) {
        const maintenanceAnswer = await prompt({
          type: "confirm",
          name: "continue",
          message:
            "Servers are currently on maintenance. Would you like to continue anyways? (invites, and profiles may not load correctly)",
          initial: false,
        });
        if (!maintenanceAnswer.continue) {
          console.log("Init canceled.");
          return;
        }
      }

      console.log("\u2713 Fetching ProgramID address + T-USDC Mint address from server...");
      try {
        const backendConfig = await getConfig(backendAnswer.backendUrl.trim());
        if (backendConfig.network) {
          backendNetwork = backendConfig.network;
          networkSource = "backend";
        }
        if (backendConfig.rpcUrl) {
          rpcUrl = backendConfig.rpcUrl;
          rpcUrlSource = "backend";
        }
        if (backendConfig.wsUrl) {
          wsUrl = backendConfig.wsUrl;
          wsUrlSource = "backend";
        }
        if (backendConfig.ephemeralProviderUrl) {
          ephemeralProviderUrl = backendConfig.ephemeralProviderUrl;
          ephemeralProviderUrlSource = "backend";
        }
        if (backendConfig.ephemeralWsUrl) {
          ephemeralWsUrl = backendConfig.ephemeralWsUrl;
          ephemeralWsUrlSource = "backend";
        }
        if (backendConfig.ephemeralValidatorIdentity) {
          ephemeralValidatorIdentity = backendConfig.ephemeralValidatorIdentity;
          ephemeralValidatorIdentitySource = "backend";
        }
        if (backendConfig.ephemeralPermissionEndpoint) {
          ephemeralPermissionEndpoint = backendConfig.ephemeralPermissionEndpoint;
          ephemeralPermissionEndpointSource = "backend";
        }
        if (backendConfig.ephemeralTeeEndpoint) {
          ephemeralTeeEndpoint = backendConfig.ephemeralTeeEndpoint;
          ephemeralTeeEndpointSource = "backend";
        }
        if (backendConfig.ephemeralTeeWsEndpoint) {
          ephemeralTeeWsEndpoint = backendConfig.ephemeralTeeWsEndpoint;
          ephemeralTeeWsEndpointSource = "backend";
        }
        if (backendConfig.programId) {
          programId = backendConfig.programId;
          programIdSource = "backend";
        }
        if (backendConfig.usdcMint) {
          usdcMint = backendConfig.usdcMint;
          usdcMintSource = "backend";
        }
        console.log("\u2713 Fetching succeeded!");
      } catch (error) {
        console.log("\u2713 Fetching failed. Using existing values.");
      }
    }

    const network =
      backendNetwork || (await promptForNetwork(config.network || "localnet"));
    if (!backendNetwork) {
      networkSource = "custom";
    }
    const networkPreset = NETWORK_PRESETS[network];

    if (modeAnswer.mode === "hosted") {
      if (!rpcUrl || !wsUrl) {
        rpcUrl = networkPreset ? networkPreset.rpcUrl : config.rpcUrl;
        wsUrl = networkPreset ? networkPreset.wsUrl : config.wsUrl;
        if (networkPreset) {
          rpcUrlSource = "official";
          wsUrlSource = "official";
        } else {
          rpcUrlSource = "custom";
          wsUrlSource = "custom";
        }
      }
      if (backendNetwork) {
        console.log(`\u2713 Select network \u00b7 ${backendNetwork}`);
      }
      console.log(`\u2713 Solana JSON RPC URL \u00b7 ${rpcUrl}`);
      console.log(`\u2713 Solana WebSocket URL \u00b7 ${wsUrl}`);
      if (ephemeralProviderUrl) {
        console.log(`\u2713 MagicBlock RPC URL \u00b7 ${ephemeralProviderUrl}`);
      }
      if (ephemeralWsUrl) {
        console.log(`\u2713 MagicBlock WebSocket URL \u00b7 ${ephemeralWsUrl}`);
      }
      if (ephemeralValidatorIdentity) {
        console.log(
          `\u2713 MagicBlock Validator Identity \u00b7 ${ephemeralValidatorIdentity}`
        );
      }
      if (ephemeralPermissionEndpoint) {
        console.log(
          `\u2713 MagicBlock Permission Endpoint \u00b7 ${ephemeralPermissionEndpoint}`
        );
      }
      if (ephemeralTeeEndpoint) {
        console.log(`\u2713 MagicBlock TEE Endpoint \u00b7 ${ephemeralTeeEndpoint}`);
      }
      if (ephemeralTeeWsEndpoint) {
        console.log(
          `\u2713 MagicBlock TEE WS Endpoint \u00b7 ${ephemeralTeeWsEndpoint}`
        );
      }
      console.log(
        chalk.gray("Hint: you can change settings later with `nebulon config`.")
      );
    } else {
      rpcUrl = networkPreset ? networkPreset.rpcUrl : config.rpcUrl;
      wsUrl = networkPreset ? networkPreset.wsUrl : config.wsUrl;

      if (network === "localnet" || network === "custom") {
        const rpcAnswer = await prompt({
          type: "input",
          name: "rpcUrl",
          message: "Solana JSON RPC URL",
          initial: networkPreset ? networkPreset.rpcUrl : config.rpcUrl,
        });

        const wsAnswer = await prompt({
          type: "input",
          name: "wsUrl",
          message: "Solana WebSocket URL",
          initial: networkPreset ? networkPreset.wsUrl : config.wsUrl,
        });

        rpcUrl = rpcAnswer.rpcUrl.trim();
        wsUrl = wsAnswer.wsUrl.trim();
        rpcUrlSource = "custom";
        wsUrlSource = "custom";
      } else if (networkPreset) {
        rpcUrlSource = "official";
        wsUrlSource = "official";
        console.log(
          `Using official Solana RPC endpoints for ${network} (change later with nebulon config).`
        );
      }
    }

    if (modeAnswer.mode !== "hosted") {
      const programAnswer = await prompt({
        type: "input",
        name: "programId",
        message: "Program ID",
        initial: programId,
      });
      programId = programAnswer.programId.trim();
      programIdSource = "custom";
    }

    if (modeAnswer.mode !== "hosted") {
      const usdcAnswer = await prompt({
        type: "input",
        name: "usdcMint",
        message: "Test-USDC mint",
        initial: usdcMint,
      });
      usdcMint = usdcAnswer.usdcMint.trim();
      usdcMintSource = "custom";
    }

    const walletConfig = await promptForWallet(config);

    config.mode = modeAnswer.mode;
    config.network = network;
    config.rpcUrl = rpcUrl;
    config.wsUrl = wsUrl;
    config.programId = programId;
    config.usdcMint = usdcMint;
    config.programIdSource = programIdSource;
    config.usdcMintSource = usdcMintSource;
    config.rpcUrlSource = rpcUrlSource;
    config.wsUrlSource = wsUrlSource;
    config.ephemeralProviderUrlSource = ephemeralProviderUrlSource;
    config.ephemeralWsUrlSource = ephemeralWsUrlSource;
    config.ephemeralValidatorIdentitySource = ephemeralValidatorIdentitySource;
    config.ephemeralPermissionEndpointSource = ephemeralPermissionEndpointSource;
    config.ephemeralTeeEndpointSource = ephemeralTeeEndpointSource;
    config.ephemeralTeeWsEndpointSource = ephemeralTeeWsEndpointSource;
    config.networkSource = networkSource;
    config.backendSource = backendSource;
    config.ephemeralProviderUrl = ephemeralProviderUrl;
    config.ephemeralWsUrl = ephemeralWsUrl;
    config.ephemeralValidatorIdentity = ephemeralValidatorIdentity;
    config.ephemeralPermissionEndpoint = ephemeralPermissionEndpoint;
    config.ephemeralTeeEndpoint = ephemeralTeeEndpoint;
    config.ephemeralTeeWsEndpoint = ephemeralTeeWsEndpoint;
    if (modeAnswer.mode === "hosted") {
      config.backendUrl = backendAnswer.backendUrl.trim();
    }

  if (walletConfig) {
    if (walletConfig.action === "generate") {
      config.wallets = {};
      const { path: walletPath, keypair } = generateWallet(walletConfig.name);
      addWalletEntry(config, walletConfig.name, walletPath);
      setActiveWallet(config, walletConfig.name);
      console.log(`Wallet address: ${keypair.publicKey.toBase58()}`);
      console.log("Tip: run `nebulon wallet export` to back it up.");
    } else if (walletConfig.action === "import") {
      config.wallets = {};
      const { path: walletPath, keypair } = importWalletFromFile(
        walletConfig.name,
        walletConfig.path
      );
      addWalletEntry(config, walletConfig.name, walletPath);
      setActiveWallet(config, walletConfig.name);
      console.log(`Wallet address: ${keypair.publicKey.toBase58()}`);
      console.log("Tip: run `nebulon wallet export` to back it up.");
      const deleteAnswer = await prompt({
        type: "confirm",
        name: "delete",
        message: `Delete "${path.basename(walletConfig.path)}" from the wallets folder? (recommended)`,
        initial: false,
      });
      if (deleteAnswer.delete === true) {
        try {
          fs.unlinkSync(walletConfig.path);
        } catch (error) {
          console.error("Unable to delete the imported file.");
        }
      }
    }
  }

    saveConfig(config);

    console.log("");
    successMessage("Initial setup complete!");
    console.log("Now run:");
    console.log("  nebulon login");
    console.log("  nebulon status");
  } catch (error) {
    if (isPromptCancel(error)) {
      console.log("Init canceled early. No changes were applied.");
      return;
    }
    throw error;
  }
};

module.exports = {
  runInit,
};

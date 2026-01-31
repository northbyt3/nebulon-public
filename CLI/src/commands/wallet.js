const fs = require("fs");
const path = require("path");
const { prompt } = require("enquirer");
const { loadConfig, saveConfig } = require("../config");
const { getConnection, getSolBalance, getTokenBalance, toPublicKey, formatAmount } = require("../solana");
const { successMessage } = require("../ui");
const {
  addWalletEntry,
  generateWallet,
  importWalletFromFile,
  listWallets,
  setActiveWallet,
  loadWalletKeypair,
} = require("../wallets");

const runWalletInit = async () => {
  const config = loadConfig();
  const actionAnswer = await prompt({
    type: "select",
    name: "action",
    message: "Wallet action",
    choices: [
      { name: "generate", message: "Generate new wallet" },
      { name: "import", message: "Import keypair file" },
    ],
  });
  const nameAnswer = await prompt({
    type: "input",
    name: "name",
    message: "Wallet name",
    initial: "default",
  });
  const name = nameAnswer.name.trim();

  if (actionAnswer.action === "generate") {
    const { path } = generateWallet(name);
    addWalletEntry(config, name, path);
    setActiveWallet(config, name);
    saveConfig(config);
    console.log(`Generated wallet: ${name}`);
    return;
  }

  const fileAnswer = await prompt({
    type: "input",
    name: "path",
    message: "Keypair file path",
    validate: (value) => {
      const trimmed = value.trim();
      if (!trimmed || !fs.existsSync(trimmed)) {
        return "File not found.";
      }
      return true;
    },
  });
  const { path } = importWalletFromFile(name, fileAnswer.path.trim());
  addWalletEntry(config, name, path);
  setActiveWallet(config, name);
  saveConfig(config);
  console.log(`Imported wallet: ${name}`);
};

const runWalletList = () => {
  const config = loadConfig();
  const wallets = listWallets(config);
  if (!wallets.length) {
    console.log("No wallets configured.");
    return;
  }
  wallets.forEach((wallet) => {
    const suffix = wallet.active ? " (active)" : "";
    console.log(`${wallet.name}${suffix}`);
  });
};

const runWalletUse = (name) => {
  const config = loadConfig();
  setActiveWallet(config, name);
  saveConfig(config);
  console.log(`Active wallet: ${name}`);
};

const runWalletShow = (name) => {
  const config = loadConfig();
  const target = name || config.activeWallet;
  if (!target) {
    console.error("No wallet specified.");
    process.exit(1);
  }
  const keypair = loadWalletKeypair(config, target);
  console.log(keypair.publicKey.toBase58());
};

const runWalletBalance = async () => {
  const config = loadConfig();
  const target = config.activeWallet;
  if (!target) {
    console.error("No active wallet. Run: nebulon init");
    process.exit(1);
  }
  const keypair = loadWalletKeypair(config, target);
  const walletKey = keypair.publicKey;
  const connection = getConnection(config.rpcUrl);
  const mintKey = toPublicKey(config.usdcMint);
  const [sol, usdc] = await Promise.all([
    getSolBalance(connection, walletKey),
    getTokenBalance(connection, walletKey, mintKey),
  ]);
  console.log(`SOL: ${formatAmount(sol, 6)} SOL`);
  console.log(`USDC: ${formatAmount(usdc, 6)} USDC`);
};

const runWalletExport = async () => {
  const config = loadConfig();
  const target = config.activeWallet;
  if (!target) {
    console.error("No active wallet. Run: nebulon init");
    process.exit(1);
  }
  const keypair = loadWalletKeypair(config, target);
  const exportDir = path.join("C:\\", "Nebulon", "Wallets");
  if (!fs.existsSync(exportDir)) {
    fs.mkdirSync(exportDir, { recursive: true });
  }
  const nameAnswer = await prompt({
    type: "input",
    name: "filename",
    message: "Export filename",
    initial: `${target}.json`,
  });
  let filename = (nameAnswer.filename || "").trim();
  if (!filename) {
    console.error("Filename required.");
    process.exit(1);
  }
  if (!filename.toLowerCase().endsWith(".json")) {
    filename = `${filename}.json`;
  }
  const targetPath = path.join(exportDir, filename);
  if (fs.existsSync(targetPath)) {
    console.log("Warning: a file already exists with that name.");
    const overwrite = await prompt({
      type: "confirm",
      name: "overwrite",
      message: "File exists. Overwrite?",
      initial: false,
    });
    if (!overwrite.overwrite) {
      console.log("Export canceled.");
      return;
    }
  }
  fs.writeFileSync(targetPath, JSON.stringify(Array.from(keypair.secretKey)));
  console.log(`Exported to ${targetPath}`);
  console.log("Store securely and delete the file when you're done.");
  successMessage("Wallet exported.");
};

module.exports = {
  runWalletInit,
  runWalletList,
  runWalletUse,
  runWalletShow,
  runWalletBalance,
  runWalletExport,
};

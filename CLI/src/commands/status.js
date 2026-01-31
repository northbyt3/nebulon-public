const { loadConfig } = require("../config");
const { getActiveCapsule } = require("../capsules");
const { loadWalletKeypair } = require("../wallets");
const { me } = require("../hosted");
const {
  formatAmount,
  getConnection,
  getSolBalance,
  getTokenBalance,
  toPublicKey,
} = require("../solana");
const { keyValue } = require("../ui");

const runStatus = async () => {
  const config = loadConfig();

  console.log("Nebulon Status");
  console.log("");

  keyValue("Capsule", getActiveCapsule());

  let loggedIn = false;
  let profile = null;
  if (config.mode === "hosted" && config.auth && config.auth.token) {
    try {
      profile = await me(config.backendUrl, config.auth.token);
      loggedIn = true;
    } catch (error) {
      loggedIn = false;
    }
  }

  keyValue("LoggedIn", loggedIn ? "true" : "false");
  keyValue(
    "NebulonID",
    loggedIn
      ? profile.nebulonId || profile.handle || "none"
      : "none"
  );

  if (!config.activeWallet) {
    keyValue("SOL", "n/a");
    keyValue("USDC", "n/a");
  } else {
    const keypair = loadWalletKeypair(config, config.activeWallet);
    try {
      const connection = getConnection(config.rpcUrl);
      const sol = await getSolBalance(connection, keypair.publicKey);
      const usdc = await getTokenBalance(
        connection,
        keypair.publicKey,
        toPublicKey(config.usdcMint)
      );
      keyValue("SOL", `${formatAmount(sol, 6)} SOL`);
      keyValue("USDC", `${formatAmount(usdc, 6)} USDC`);
    } catch (error) {
      keyValue("SOL", "unavailable");
      keyValue("USDC", "unavailable");
    }
  }

  console.log("");
  keyValue("Mode", config.mode);
  keyValue("Network", config.network);
  console.log("");
  keyValue("Pending Invites", "n/a");
  keyValue("Active Contracts", "n/a");
};

module.exports = {
  runStatus,
};

const { loadConfig } = require("../config");
const { runLogin } = require("./login");
const { me, faucet } = require("../hosted");
const { ensureHostedSession } = require("../session");
const { successMessage } = require("../ui");

const ensureHosted = (config) => {
  if (config.mode !== "hosted") {
    console.error("Hosted commands require hosted mode.");
    process.exit(1);
  }
};

const runHostedLogin = async (options = {}) => {
  await runLogin(options);
};

const runHostedMe = async () => {
  const config = loadConfig();
  ensureHosted(config);
  try {
    await ensureHostedSession(config, { quiet: true });
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
  const profile = await me(config.backendUrl, config.auth.token);
  console.log(JSON.stringify(profile, null, 2));
};

const runHostedFaucet = async () => {
  const config = loadConfig();
  ensureHosted(config);
  try {
    await ensureHostedSession(config, { quiet: true });
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
  try {
    const result = await faucet(config.backendUrl, config.auth.token);
    console.log("Faucet request submitted.");
    console.log(`Amount: ${result.amount} USDC`);
    console.log(`Mint: ${result.mint}`);
    console.log(`Token account: ${result.tokenAccount}`);
    console.log(`Network: ${result.network}`);
    console.log(`Tx: ${result.txSig}`);
    if (result.nextAvailableAt) {
      console.log("Next available: try again later.");
    }
    successMessage("Faucet request completed.");
  } catch (error) {
    const code = error.message || "faucet_failed";
    const details = error.data || {};
    if (code === "wallet_rate_limited" || code === "ip_rate_limited") {
      console.error("Faucet rate limit reached.");
      console.error("Try again later.");
      return;
    }
    if (code === "faucet_disabled") {
      console.error("Faucet is disabled on this server.");
      return;
    }
    if (code === "faucet_network_blocked") {
      console.error("Faucet is not enabled for this network.");
      if (details.network) {
        console.error(`Network: ${details.network}`);
      }
      return;
    }
    if (code === "faucet_not_configured") {
      console.error("Faucet is not configured yet.");
      return;
    }
    if (code === "faucet_failed") {
      console.error("Faucet request failed.");
      if (details.message) {
        console.error(details.message);
      }
      return;
    }
    console.error(`Faucet request failed: ${code}`);
  }
};

module.exports = {
  runHostedLogin,
  runHostedMe,
  runHostedFaucet,
};

const { loadConfig, saveConfig } = require("../config");

const runLogout = async () => {
  const config = loadConfig();
  if (!config.auth) {
    console.log("Already logged out.");
    return;
  }
  config.auth = {
    token: null,
    wallet: null,
    handle: null,
    role: null,
    lastAuthAt: null,
  };
  saveConfig(config);
  console.log("Logged out.");
};

module.exports = {
  runLogout,
};

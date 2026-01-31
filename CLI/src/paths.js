const os = require("os");
const path = require("path");

const nebulonHome = () =>
  process.env.NEBULON_HOME || path.join(os.homedir(), ".nebulon");

const legacyConfigPath = () => path.join(nebulonHome(), "config.json");
const legacyWalletsDir = () => path.join(nebulonHome(), "wallets");
const capsulesDir = () => path.join(nebulonHome(), "capsules");
const activeCapsulePath = () => path.join(nebulonHome(), "active-capsule.json");
const capsuleRoot = (name) => path.join(capsulesDir(), name);
const capsuleConfigPath = (name) => path.join(capsuleRoot(name), "config.json");
const capsuleWalletsDir = (name) => path.join(capsuleRoot(name), "wallets");

module.exports = {
  nebulonHome,
  legacyConfigPath,
  legacyWalletsDir,
  capsulesDir,
  activeCapsulePath,
  capsuleRoot,
  capsuleConfigPath,
  capsuleWalletsDir,
};

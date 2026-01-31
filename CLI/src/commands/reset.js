const fs = require("fs");
const { prompt } = require("enquirer");
const {
  activeCapsulePath,
  capsuleRoot,
  capsulesDir,
  legacyConfigPath,
  legacyWalletsDir,
  nebulonHome,
} = require("../paths");
const {
  getActiveCapsule,
  listCapsules,
  readActiveState,
  writeActiveState,
} = require("../capsules");

const safeRemove = (targetPath) => {
  if (!targetPath || !fs.existsSync(targetPath)) {
    return false;
  }
  const stats = fs.statSync(targetPath);
  if (stats.isDirectory()) {
    fs.rmSync(targetPath, { recursive: true, force: true });
  } else {
    fs.rmSync(targetPath, { force: true });
  }
  return true;
};

const runReset = async (scope) => {
  const resetAll = scope === "capsules";
  if (scope && !resetAll) {
    console.log("Usage: nebulon reset [capsules]");
    return;
  }

  if (resetAll) {
    console.log("This will reset all Nebulon CLI capsules.");
  } else {
    const capsule = getActiveCapsule();
    console.log(`This will reset capsule "${capsule}".`);
  }
  console.log("Imported wallets in C:\\nebulon\\wallets are preserved.");

  const answer = await prompt({
    type: "confirm",
    name: "confirm",
    message: "Proceed with reset?",
    initial: false,
  });

  if (!answer.confirm) {
    console.log("Reset canceled.");
    return;
  }

  if (resetAll) {
    listCapsules().forEach((capsule) => {
      safeRemove(capsuleRoot(capsule));
    });
    safeRemove(capsulesDir());
    safeRemove(activeCapsulePath());
    safeRemove(legacyConfigPath());
    safeRemove(legacyWalletsDir());
  } else {
    const capsule = getActiveCapsule();
    safeRemove(capsuleRoot(capsule));
    const state = readActiveState();
    const remaining = listCapsules().filter((name) => name !== capsule);
    if (state.sessions) {
      Object.keys(state.sessions).forEach((key) => {
        if (state.sessions[key] === capsule) {
          delete state.sessions[key];
        }
      });
    }
    state.lastUsed = remaining.length ? remaining[0] : null;
    if (remaining.length) {
      writeActiveState(state);
    } else {
      safeRemove(activeCapsulePath());
      safeRemove(capsulesDir());
    }
  }

  const home = nebulonHome();
  if (fs.existsSync(home)) {
    const remaining = fs.readdirSync(home);
    if (remaining.length === 0) {
      fs.rmSync(home, { recursive: true, force: true });
    }
  }

  console.log(
    "The Nebulon CLI has been reset successfully. Run nebulon init to get started."
  );
};

module.exports = {
  runReset,
};

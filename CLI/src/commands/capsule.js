const {
  listCapsules,
  migrateLegacyIfNeeded,
  readActiveState,
  setActiveCapsule,
} = require("../capsules");

const runCapsuleList = () => {
  migrateLegacyIfNeeded();
  const capsules = listCapsules();
  if (!capsules.length) {
    console.log("No capsules found. Run `nebulon init` to create one.");
    return;
  }

  const state = readActiveState();
  const sessionId = String(process.ppid || process.pid);
  const active = state.sessions && state.sessions[sessionId]
    ? state.sessions[sessionId]
    : state.lastUsed;

  console.log("Capsules");
  capsules.forEach((name) => {
    const marker = name === active ? "*" : " ";
    console.log(`${marker} ${name}`);
  });
};

const runCapsuleUse = (name) => {
  if (!name) {
    console.log("Usage: nebulon capsule use <name>");
    return;
  }
  try {
    const capsule = setActiveCapsule(name);
    console.log(`Capsule active: ${capsule}`);
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
};

module.exports = {
  runCapsuleList,
  runCapsuleUse,
};

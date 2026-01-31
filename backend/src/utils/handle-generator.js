const { ADJECTIVES, NOUNS } = require("../wordlist");
const { isReservedHandle } = require("./reserved");

const randomItem = (items) =>
  items[Math.floor(Math.random() * items.length)];

const generateCandidate = () => {
  const adj = randomItem(ADJECTIVES);
  const noun = randomItem(NOUNS);
  const suffix = Math.floor(100 + Math.random() * 900);
  return `${adj}-${noun}-${suffix}`;
};

const generateHandle = (db) => {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const candidate = generateCandidate();
    if (candidate.length > 16) {
      continue;
    }
    const reserved = isReservedHandle(db, candidate);
    if (reserved) {
      continue;
    }
    const exists = db
      .prepare("SELECT 1 FROM users WHERE handle = ?")
      .get(candidate);
    if (!exists) {
      return candidate;
    }
  }
  return `user-${Math.floor(1000 + Math.random() * 9000)}`;
};

module.exports = {
  generateHandle,
};

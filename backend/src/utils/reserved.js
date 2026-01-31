const fs = require("fs");
const path = require("path");

const RESERVED_PATH = path.join(__dirname, "..", "reserved-words.json");
const CACHE_TTL_SECONDS = 300;

const cache = {
  words: null,
  loadedAt: 0,
};

const loadReservedFromFile = () => {
  const raw = fs.readFileSync(RESERVED_PATH, "utf8");
  const words = JSON.parse(raw);
  return words.map((word) => word.toLowerCase());
};

const seedReservedWords = (db) => {
  const words = loadReservedFromFile();
  const now = Math.floor(Date.now() / 1000);

  const insert = db.prepare(
    "INSERT OR REPLACE INTO reserved_handles (word, reason, admin_only, created_at) VALUES (?, ?, 1, ?)"
  );
  const insertMany = db.transaction((items) => {
    for (const word of items) {
      insert.run(word, "seed", now);
    }
  });
  insertMany(words);

  // Clear cache so it reloads with new words
  refreshReservedCache();
};

const getReservedWords = (db) => {
  const now = Math.floor(Date.now() / 1000);
  if (!cache.words || now - cache.loadedAt > CACHE_TTL_SECONDS) {
    const rows = db.prepare("SELECT word FROM reserved_handles").all();
    cache.words = rows.map((row) => row.word.toLowerCase());
    cache.loadedAt = now;
  }
  return cache.words;
};

const refreshReservedCache = () => {
  cache.words = null;
  cache.loadedAt = 0;
};

const isReservedHandle = (db, handle) => {
  const words = getReservedWords(db);
  return words.find((word) => handle.includes(word)) || null;
};

const addReservedWord = (db, word, reason) => {
  const now = Math.floor(Date.now() / 1000);
  db.prepare(
    "INSERT OR IGNORE INTO reserved_handles (word, reason, admin_only, created_at) VALUES (?, ?, 1, ?)"
  ).run(word.toLowerCase(), reason || "admin", now);
  refreshReservedCache();
};

const removeReservedWord = (db, word) => {
  db.prepare("DELETE FROM reserved_handles WHERE word = ?").run(
    word.toLowerCase()
  );
  refreshReservedCache();
};

module.exports = {
  seedReservedWords,
  getReservedWords,
  isReservedHandle,
  addReservedWord,
  removeReservedWord,
};

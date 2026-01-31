const { nowSeconds } = require("./time");

const logAudit = (db, actorWallet, action, targetType, targetId, details) => {
  const payload = details ? JSON.stringify(details) : null;
  db.prepare(
    "INSERT INTO audit_log (actor_wallet, action, target_type, target_id, details_json, created_at) VALUES (?, ?, ?, ?, ?, ?)"
  ).run(actorWallet, action, targetType || null, targetId || null, payload, nowSeconds());
};

module.exports = { logAudit };

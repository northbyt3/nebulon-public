const jwt = require("jsonwebtoken");
const { JWT_SECRET } = require("../config");
const { db } = require("../db");

const requireAuth = (req, res, next) => {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;
  if (!token) {
    return res.status(401).json({ error: "missing_token" });
  }
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    const user = db
      .prepare("SELECT wallet, handle, role FROM users WHERE wallet = ?")
      .get(payload.wallet);
    if (!user) {
      return res.status(401).json({ error: "unknown_user" });
    }
    req.user = {
      wallet: user.wallet,
      handle: user.handle,
      role: user.role,
    };
    return next();
  } catch (error) {
    return res.status(401).json({ error: "invalid_token" });
  }
};

const requireAdmin = (req, res, next) => {
  if (!req.user || req.user.role !== "admin") {
    return res.status(403).json({ error: "forbidden" });
  }
  return next();
};

module.exports = {
  requireAuth,
  requireAdmin,
};

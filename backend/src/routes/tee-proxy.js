const express = require("express");
const {
  EPHEMERAL_TEE_ENDPOINT,
  EPHEMERAL_PERMISSION_ENDPOINT,
} = require("../config");

const router = express.Router();

const resolveTeeBase = () =>
  (EPHEMERAL_TEE_ENDPOINT ||
    EPHEMERAL_PERMISSION_ENDPOINT ||
    "https://tee.magicblock.app"
  ).replace(/\/$/, "");

const buildTeeUrl = (token) => {
  const base = resolveTeeBase();
  return `${base}?token=${encodeURIComponent(token)}`;
};

router.post("/", async (req, res) => {
  const token = req.query.token;
  if (!token || typeof token !== "string") {
    return res.status(400).json({ error: "missing_token" });
  }
  const url = buildTeeUrl(token);
  const body = req.body || {};
  try {
    const method = typeof body.method === "string" ? body.method : "unknown";
    const paramsSize = Array.isArray(body.params) ? body.params.length : null;
    const bodyLength = Buffer.byteLength(JSON.stringify(body));
    console.log(
      "TEE proxy payload:",
      `method=${method}`,
      paramsSize !== null ? `params=${paramsSize}` : "params=unknown",
      `bytes=${bodyLength}`
    );
  } catch (error) {
    console.warn("TEE proxy payload log failed:", error?.message || error);
  }

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const text = await response.text();
    if (!response.ok) {
      console.warn("TEE proxy upstream error:", response.status, text.slice(0, 200));
    }
    const contentType = response.headers.get("content-type") || "";
    if (contentType.includes("application/json")) {
      try {
        const data = JSON.parse(text);
        return res.status(response.status).json(data);
      } catch {
        return res.status(response.status).send(text);
      }
    }
    return res.status(response.status).send(text);
  } catch (error) {
    console.error("TEE proxy error:", error);
    return res.status(502).json({ error: "tee_proxy_failed" });
  }
});

router.get("/ping", async (req, res) => {
  const token = req.query.token;
  if (!token || typeof token !== "string") {
    return res.status(400).json({ error: "missing_token" });
  }
  const url = buildTeeUrl(token);
  const payload = {
    jsonrpc: "2.0",
    id: 1,
    method: "getVersion",
    params: [],
  };

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const text = await response.text();
    const contentType = response.headers.get("content-type") || "";
    if (contentType.includes("application/json")) {
      try {
        const data = JSON.parse(text);
        return res.status(response.status).json({
          ok: response.ok,
          status: response.status,
          data,
        });
      } catch {
        return res.status(response.status).json({
          ok: response.ok,
          status: response.status,
          raw: text,
        });
      }
    }
    return res.status(response.status).json({
      ok: response.ok,
      status: response.status,
      raw: text.slice(0, 2000),
    });
  } catch (error) {
    console.error("TEE proxy ping error:", error);
    return res.status(502).json({ error: "tee_proxy_ping_failed" });
  }
});

module.exports = router;

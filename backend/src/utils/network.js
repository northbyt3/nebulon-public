const normalizeNetwork = (rpcUrl, override) => {
  if (override) {
    return override.toLowerCase();
  }
  if (!rpcUrl) {
    return "unknown";
  }
  const lower = rpcUrl.toLowerCase();
  if (lower.includes("localhost") || lower.includes("127.0.0.1")) {
    return "localnet";
  }
  if (lower.includes("devnet")) {
    return "devnet";
  }
  if (lower.includes("mainnet")) {
    return "mainnet";
  }
  return "custom";
};

const deriveWsUrl = (rpcUrl) => {
  if (!rpcUrl) {
    return "";
  }
  try {
    const url = new URL(rpcUrl);
    const isLocal = url.hostname === "localhost" || url.hostname === "127.0.0.1";
    if (isLocal && url.port === "8899") {
      url.port = "8900";
    }
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    return url.toString();
  } catch (error) {
    return "";
  }
};

module.exports = {
  normalizeNetwork,
  deriveWsUrl,
};

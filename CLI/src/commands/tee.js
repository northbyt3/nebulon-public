const nacl = require("tweetnacl");
const { Connection } = require("@solana/web3.js");
const { getAuthToken } = require("@magicblock-labs/ephemeral-rollups-sdk");
const { loadConfig } = require("../config");
const { loadWalletKeypair } = require("../wallets");

const normalizeEndpoint = (endpoint) => endpoint.replace(/\/$/, "");

const checkTeeAvailability = async (config, keypair, options = {}) => {
  const base = normalizeEndpoint(
    config.ephemeralTeeEndpoint ||
      config.ephemeralPermissionEndpoint ||
      "https://tee.magicblock.app"
  );
  try {
    const auth = await getAuthToken(
      base,
      keypair.publicKey,
      (message) => nacl.sign.detached(message, keypair.secretKey)
    );
    if (!auth?.token) {
      return { ok: false, reason: "no_token" };
    }
    const rpcEndpoint = `${base}?token=${auth.token}`;
    let wsEndpoint =
      config.ephemeralTeeWsEndpoint ||
      rpcEndpoint.replace(/^https:/, "wss:").replace(/^http:/, "ws:");
    if (!wsEndpoint.includes("token=")) {
      wsEndpoint += wsEndpoint.includes("?")
        ? `&token=${auth.token}`
        : `?token=${auth.token}`;
    }

    const connection = new Connection(rpcEndpoint, {
      commitment: "confirmed",
      wsEndpoint,
    });
    await connection.getVersion();
    let notified = false;
    await new Promise((resolve) => {
      const timeout = setTimeout(resolve, options.timeoutMs || 4000);
      connection.onSlotChange((info) => {
        if (!notified) {
          notified = true;
          clearTimeout(timeout);
          resolve(info.slot);
        }
      });
    });
    if (!notified) {
      return { ok: false, reason: "ws_timeout" };
    }
    return { ok: true };
  } catch (error) {
    if (options.debug) {
      console.error(error);
    }
    return { ok: false, reason: "error" };
  }
};

const runTestTee = async (options = {}) => {
  const config = loadConfig();
  if (!config.activeWallet) {
    console.error("No active wallet. Run: nebulon init");
    process.exit(1);
  }
  const keypair = loadWalletKeypair(config, config.activeWallet);
  const base = normalizeEndpoint(
    config.ephemeralTeeEndpoint ||
      config.ephemeralPermissionEndpoint ||
      "https://tee.magicblock.app"
  );
  const pubkey = keypair.publicKey.toBase58();

  console.log("Testing TEE endpoints...");
  console.log(`TEE base: ${base}`);
  console.log(`Wallet: ${pubkey}`);

  try {
    const challengeUrl = `${base}/auth/challenge?pubkey=${pubkey}`;
    const response = await fetch(challengeUrl);
    const contentType = response.headers.get("content-type") || "unknown";
    const bodyText = await response.text();
    console.log(`Challenge status: ${response.status}`);
    console.log(`Challenge content-type: ${contentType}`);
    if (options.debug) {
      console.log(
        `Challenge body head: ${bodyText.slice(0, 200).replace(/\s+/g, " ")}`
      );
    }
  } catch (error) {
    console.error("Challenge request failed.");
    if (options.debug) {
      console.error(error);
    }
  }

  let auth = null;
  try {
    auth = await getAuthToken(
      base,
      keypair.publicKey,
      (message) => nacl.sign.detached(message, keypair.secretKey)
    );
    console.log("Auth token acquired.");
    if (auth?.expiresAt) {
      console.log(`Token expiresAt: ${auth.expiresAt}`);
    }
  } catch (error) {
    console.error("Auth token request failed.");
    if (options.debug) {
      console.error(error);
    }
    return;
  }

  const token = auth?.token;
  if (!token) {
    console.error("No token returned from TEE.");
    return;
  }
  const rpcEndpoint = `${base}?token=${token}`;
  let wsEndpoint =
    config.ephemeralTeeWsEndpoint ||
    rpcEndpoint.replace(/^https:/, "wss:").replace(/^http:/, "ws:");
  if (!wsEndpoint.includes("token=")) {
    wsEndpoint += wsEndpoint.includes("?") ? `&token=${token}` : `?token=${token}`;
  }

  console.log(`TEE RPC: ${rpcEndpoint}`);
  console.log(`TEE WS: ${wsEndpoint}`);

  try {
    const connection = new Connection(rpcEndpoint, {
      commitment: "confirmed",
      wsEndpoint,
    });
    const version = await connection.getVersion();
    console.log(`TEE RPC OK. Solana version: ${version["solana-core"]}`);

    let notified = false;
    const slotPromise = new Promise((resolve) => {
      const timeout = setTimeout(resolve, 4000);
      connection.onSlotChange((info) => {
        if (!notified) {
          notified = true;
          clearTimeout(timeout);
          console.log(`TEE WS OK. Slot: ${info.slot}`);
          resolve();
        }
      });
    });
    await slotPromise;
    if (!notified) {
      console.warn("TEE WS did not emit a slot notification within 4s.");
    }
  } catch (error) {
    console.error("TEE RPC check failed.");
    if (options.debug) {
      console.error(error);
    }
  }
};

module.exports = {
  runTestTee,
  checkTeeAvailability,
};

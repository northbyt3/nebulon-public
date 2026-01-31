require("dotenv").config();

const hasCliFlag = (flag) => {
  if (process.argv.includes(flag)) {
    return true;
  }
  if (flag === "--localnet") {
    if (process.env.NEBULON_LOCALNET === "1" || process.env.NEBULON_LOCALNET === "true") {
      return true;
    }
    if (process.env.LOCALNET === "1" || process.env.LOCALNET === "true") {
      return true;
    }
    if (process.env.npm_config_localnet === "true" || process.env.npm_config_localnet === "1") {
      return true;
    }
  }
  const npmArgvRaw = process.env.npm_config_argv;
  if (!npmArgvRaw) {
    return false;
  }
  try {
    const npmArgv = JSON.parse(npmArgvRaw);
    const allArgs = []
      .concat(npmArgv.original || [])
      .concat(npmArgv.cooked || []);
    return allArgs.includes(flag);
  } catch (error) {
    return false;
  }
};

if (hasCliFlag("--localnet")) {
  process.env.SOLANA_RPC_URL = "http://localhost:8899";
  process.env.SOLANA_WS_URL = "ws://localhost:8900";
  process.env.SOLANA_NETWORK = "localnet";
  process.env.EPHEMERAL_PROVIDER_ENDPOINT = "http://localhost:7799";
  process.env.EPHEMERAL_WS_ENDPOINT = "ws://localhost:7800";
  process.env.EPHEMERAL_VALIDATOR_IDENTITY =
    "mAGicPQYBMvcYveUZA5F5UNNwyHvfYh5xkLS2Fr1mev";
  process.env.EPHEMERAL_PERMISSION_ENDPOINT = "";
  process.env.EPHEMERAL_TEE_ENDPOINT = "";
  process.env.EPHEMERAL_TEE_WS_ENDPOINT = "";
  process.env.USDC_MINT = "";
}

const { version } = require("../package.json");

console.log(`NEBULON - Offchain Server - v${version}`);
console.log("");

const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const os = require("os");
const rateLimit = require("express-rate-limit");
const {
  BASE_URL,
  PORT,
  SOLANA_RPC_URL,
  SOLANA_WS_URL,
  SOLANA_NETWORK,
  EPHEMERAL_PROVIDER_ENDPOINT,
  EPHEMERAL_WS_ENDPOINT,
  FAUCET_ENABLED,
  DEFAULT_JUDGE,
} = require("./config");
const { deriveWsUrl, normalizeNetwork } = require("./utils/network");
const { ensureFaucetMint } = require("./utils/faucet-mint");
// Initialize database (this creates tables if they don't exist)
const { db } = require("./db");

const hasShowUsersFlag = () => {
  if (process.argv.includes("--show-users")) {
    return true;
  }
  if (
    process.env.npm_config_show_users ||
    process.env.npm_config_showusers
  ) {
    return true;
  }
  const npmArgvRaw = process.env.npm_config_argv;
  if (!npmArgvRaw) {
    return false;
  }
  try {
    const npmArgv = JSON.parse(npmArgvRaw);
    const allArgs = []
      .concat(npmArgv.original || [])
      .concat(npmArgv.cooked || []);
    return allArgs.includes("--show-users");
  } catch (error) {
    return false;
  }
};

// Display current registered users on server start
const displayCurrentUsers = () => {
  try {
    const users = db
      .prepare("SELECT wallet, handle, role, created_at FROM users ORDER BY created_at DESC")
      .all();
    console.log("\nCURRENT REGISTERED USERS:");
    console.log("=".repeat(80));

    if (users.length === 0) {
      console.log("No users registered yet");
    } else {
      console.log(`Total users: ${users.length}`);
      console.log("");

      users.forEach((user, index) => {
        const walletShort = `${user.wallet.slice(0, 8)}...${user.wallet.slice(-8)}`;
        const createdDate = new Date(user.created_at * 1000).toLocaleString();
        const roleLabel = user.role === "admin" ? "ADMIN" : "USER";

        console.log(`${index + 1}. ${user.handle || "NO HANDLE"} (${roleLabel})`);
        console.log(`   Wallet: ${walletShort}`);
        console.log(`   Created: ${createdDate}`);
        console.log("");
      });
    }

    console.log("=".repeat(80));
    console.log("");
  } catch (error) {
    console.log("Error displaying users:", error.message);
  }
};
const authRoutes = require("./routes/auth");
const configRoutes = require("./routes/config");
const idRoutes = require("./routes/ids");
const inviteRoutes = require("./routes/invites");
const contractRoutes = require("./routes/contracts");
const adminRoutes = require("./routes/admin");
const faucetRoutes = require("./routes/faucet");
const { startIndexer } = require("./indexer");

const app = express();

app.use(helmet());
app.use(cors());
app.use(express.json({ limit: "1mb" }));

const authLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
});

app.get("/health", (req, res) => {
  res.json({ status: "ok" });
});

app.use("/v1/auth", authLimiter, authRoutes);
app.use("/v1/config", configRoutes);
app.use("/v1/ids", idRoutes);
app.use("/v1/invites", inviteRoutes);
app.use("/v1/contracts", contractRoutes);
app.use("/v1/admin", adminRoutes);
app.use("/v1/faucet", faucetRoutes);

app.use((err, req, res, next) => {
  console.error('Global error handler:', err);
  console.error('Request path:', req.path);
  console.error('Request method:', req.method);
  console.error('Request headers:', req.headers);
  res.status(500).json({ error: "server_error" });
});

app.listen(PORT, () => {
  const network = normalizeNetwork(SOLANA_RPC_URL, SOLANA_NETWORK);
  console.log(`Network: ${network}`);
  console.log(`Solana URL: ${SOLANA_RPC_URL}`);
  console.log(
    `Solana WebSocket URL: ${SOLANA_WS_URL || deriveWsUrl(SOLANA_RPC_URL)}`
  );
  if (EPHEMERAL_PROVIDER_ENDPOINT) {
    console.log(`MagicBlock RPC URL: ${EPHEMERAL_PROVIDER_ENDPOINT}`);
  }
  if (EPHEMERAL_WS_ENDPOINT) {
    console.log(`MagicBlock WebSocket URL: ${EPHEMERAL_WS_ENDPOINT}`);
  }
  console.log(`JUDGE: ${DEFAULT_JUDGE}`);
  console.log("");

  const getLocalIp = () => {
    const nets = os.networkInterfaces();
    const candidates = [];
    for (const name of Object.keys(nets)) {
      for (const net of nets[name] || []) {
        if (net.family === "IPv4" && !net.internal) {
          candidates.push(net.address);
        }
      }
    }
    if (!candidates.length) {
      return null;
    }
    const scoreIp = (ip) => {
      if (ip.startsWith("192.168.")) {
        return 1;
      }
      if (ip.startsWith("10.")) {
        return 2;
      }
      if (ip.startsWith("172.")) {
        return 3;
      }
      return 4;
    };
    candidates.sort((a, b) => scoreIp(a) - scoreIp(b));
    return candidates[0];
  };

  const localIp = getLocalIp();
  if (hasShowUsersFlag()) {
    displayCurrentUsers();
  }

  if (process.env.ENABLE_INDEXER === "true") {
    startIndexer().catch((error) => {
      console.error("indexer fatal", error);
    });
  }

  const finalizeStartup = () => {
    console.log("");
    console.log("Server ready initialized successfully");
    console.log("");
    console.log(`Server URL: ${BASE_URL}`);
    if (localIp) {
      try {
        const url = new URL(BASE_URL);
        url.hostname = localIp;
        console.log(`Server URL (LAN): ${url.toString()}`);
      } catch (error) {
        console.log(`Server URL (LAN): http://${localIp}:${PORT}`);
      }
    }
  };

  if (FAUCET_ENABLED) {
    ensureFaucetMint()
      .then((result) => {
        if (result.ok) {
          console.log(`Test-USDC mint ready: ${result.mint.toBase58()}`);
        } else if (result.reason === "insufficient_funds") {
          console.log("Test-USDC mint missing (insufficient funds).");
          console.log(`Mint: ${result.mint.toBase58()}`);
          console.log(`Payer: ${result.payer.toBase58()}`);
          console.log(`Required SOL: ${result.requiredSol.toFixed(4)}`);
          console.log(
            `Fund with: solana transfer ${result.payer.toBase58()} ${result.requiredSol.toFixed(4)}`
          );
        } else if (result.reason === "mint_missing") {
          console.log(`Test-USDC mint missing: ${result.mint.toBase58()}`);
        }
      })
      .catch((error) => {
        console.log("Test-USDC mint check failed:", error.message || error);
      })
      .finally(() => {
        finalizeStartup();
      });
  } else {
    finalizeStartup();
  }
});

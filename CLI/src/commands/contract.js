
const { prompt } = require("enquirer");
const chalk = require("chalk");
const anchor = require("@coral-xyz/anchor");
const crypto = require("crypto");
const nacl = require("tweetnacl");
const {
  PublicKey,
  Keypair,
  SystemProgram,
  Transaction,
  Connection,
} = require("@solana/web3.js");
const {
  createAssociatedTokenAccountIdempotent,
  getAssociatedTokenAddress,
  getAccount,
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
} = require("@solana/spl-token");
const { SessionTokenManager } = require("@magicblock-labs/gum-sdk");
const {
  createDelegatePermissionInstruction,
  permissionPdaFromAccount,
  PERMISSION_PROGRAM_ID,
  AUTHORITY_FLAG,
  TX_LOGS_FLAG,
  MAGIC_PROGRAM_ID,
  MAGIC_CONTEXT_ID,
  DELEGATION_PROGRAM_ID,
  ConnectionMagicRouter,
  getAuthToken,
  getPermissionStatus,
  waitUntilPermissionActive,
} = require("@magicblock-labs/ephemeral-rollups-sdk");
const { loadConfig, saveConfig } = require("../config");
const { loadWalletKeypair } = require("../wallets");
const { ensureHostedSession } = require("../session");
const { successMessage, errorMessage } = require("../ui");
const { checkTeeAvailability } = require("./tee");
const {
  getContracts,
  getContract,
  getContractKeys,
  createInvite,
  setContractKey,
  updateContract,
  lockContract,
  signContract,
  markFunded,
  refreshContract,
  linkEscrow,
  rateContract,
} = require("../hosted");
const {
  formatAmount,
  getConnection,
  getSolBalance,
  getTokenBalance,
  toPublicKey,
  getEscrowState,
  getMilestoneState,
} = require("../solana");
const {
  getProgram,
  deriveMilestonePda,
  derivePrivateMilestonePda,
  deriveEscrowPda,
  deriveTermsPda,
  derivePerVaultPda,
  deriveDisputePda,
  textToHash,
} = require("../nebulon");
const {
  ensureContractKeypair,
  deriveContractKey,
  encryptPayload,
  decryptPayload,
  isEncryptedPayload,
} = require("../privacy");

const FEE_RECEIVER = new PublicKey(
  "w8sdYr2sM1dfyD7vsTt6EXcQWQ1mfNWfQJMzQNNnUXq"
);
const LOCAL_VALIDATOR_IDENTITY = new PublicKey(
  "mAGicPQYBMvcYveUZA5F5UNNwyHvfYh5xkLS2Fr1mev"
);
const FEE_BPS = 200n;
const BPS_DENOMINATOR = 10_000n;

const ACTIVE_STATUSES = new Set([
  "waiting_for_milestones_report",
  "in_progress",
  "ready_to_claim",
]);

const EXCLUDE_INVITE_STATUSES = new Set([
  "pending_invite",
  "invite_expired",
  "invite_canceled",
]);

const ROLE_CHOICES = [
  {
    name: "client",
    message: `Im the Client ${chalk.gray("(Ill fund this contract)")}`,
    value: "client",
  },
  {
    name: "contractor",
    message: `Im the Service Provider ${chalk.gray(
      "(The other user will fund this contract)"
    )}`,
    value: "contractor",
  },
];

const SHARE_CHOICES = [
  { name: "direct", message: "invite directly by Nebulon ID", value: "direct" },
  { name: "link", message: "generate an invitation link", value: "link" },
  { name: "code", message: "generate a contract code", value: "code" },
];

const isPromptCancel = (error) => {
  if (!error) {
    return true;
  }
  if (typeof error === "string") {
    return error.trim() === "";
  }
  const message = (error.message || "").toLowerCase();
  return (
    message.includes("cancel") ||
    message.includes("aborted") ||
    message.includes("terminated")
  );
};

const normalizeHandle = (value) =>
  value.trim().toLowerCase().replace(/^@/, "");

let cachedValidator = null;
let cachedValidatorEndpoint = null;

const normalizeEndpoint = (endpoint) => endpoint.replace(/\/$/, "");

const TEE_TOKEN_TTL_SECONDS = 240;
const teeTokenCache = new Map();
const teeWsHealthCache = new Map();
const teeProgramCache = new Map();

const isLocalnetConfig = (config) => {
  const network = (config?.network || config?.solanaNetwork || "").toLowerCase();
  if (network === "localnet") {
    return true;
  }
  const rpc = String(config?.rpcUrl || "");
  const er = String(config?.ephemeralProviderUrl || "");
  return (
    rpc.includes("localhost:8899") ||
    rpc.includes("127.0.0.1:8899") ||
    er.includes("localhost:7799") ||
    er.includes("127.0.0.1:7799")
  );
};

const getTeeEndpoint = async (config, keypair, options = {}) => {
  const base = normalizeEndpoint(
    config.ephemeralTeeEndpoint ||
      config.ephemeralPermissionEndpoint ||
      "https://tee.magicblock.app"
  );
  const cacheKey = `${base}:${keypair.publicKey.toBase58()}`;
  const cached = teeTokenCache.get(cacheKey);
  const now = Math.floor(Date.now() / 1000);
  if (!options.forceRefresh && cached && cached.expiresAt > now) {
    return cached;
  }
  const auth = await getAuthToken(
    base,
    keypair.publicKey,
    (message) => nacl.sign.detached(message, keypair.secretKey)
  );
  const endpoint = `${base}?token=${auth.token}`;
  const expiresAt = now + TEE_TOKEN_TTL_SECONDS;
  const record = { endpoint, token: auth.token, expiresAt };
  teeTokenCache.set(cacheKey, record);
  return record;
};

const getEphemeralProgram = async (config, signerKeypair, options = {}) => {
  if (isLocalnetConfig(config)) {
    return getProgram(config, signerKeypair, {
      endpoint: config.ephemeralProviderUrl || config.rpcUrl,
      wsEndpoint: config.ephemeralWsUrl || undefined,
    });
  }
  const cacheKey = signerKeypair.publicKey.toBase58();
  const cached = teeProgramCache.get(cacheKey);
  const now = Math.floor(Date.now() / 1000);
  if (!options.forceRefresh && cached && cached.expiresAt > now + 30) {
    return cached.bundle;
  }
  const { endpoint, token, expiresAt } = await getTeeEndpoint(
    config,
    signerKeypair,
    options
  );
  let wsEndpoint =
    config.ephemeralTeeWsEndpoint ||
    endpoint.replace(/^https:/, "wss:").replace(/^http:/, "ws:");
  if (token && !wsEndpoint.includes("token=")) {
    wsEndpoint += wsEndpoint.includes("?") ? `&token=${token}` : `?token=${token}`;
  }
  if (process.env.NEBULON_TEE_DEBUG === "1") {
    console.log("TEE signer:", signerKeypair.publicKey.toBase58());
    console.log("TEE RPC endpoint:", endpoint);
    console.log("TEE WS endpoint:", wsEndpoint);
  }
  const programBundle = getProgram(config, signerKeypair, {
    endpoint,
    wsEndpoint,
  });
  await ensureTeeWsHealthy(programBundle.provider.connection, wsEndpoint);
  teeProgramCache.set(cacheKey, { bundle: programBundle, expiresAt });
  return programBundle;
};

const ensureTeeWsHealthy = async (connection, wsEndpoint) => {
  if (!connection || !wsEndpoint) {
    return;
  }
  const cacheKey = wsEndpoint;
  const now = Date.now();
  const cached = teeWsHealthCache.get(cacheKey);
  if (cached && cached.expiresAt > now) {
    return;
  }

  const timeoutMs = 4000;
  let subscriptionId = null;
  let resolved = false;
  try {
    if (process.env.NEBULON_TEE_DEBUG === "1") {
      console.log("TEE WS health check: subscribing for slot change...");
    }
    subscriptionId = connection.onSlotChange((info) => {
      if (!resolved) {
        resolved = true;
        if (process.env.NEBULON_TEE_DEBUG === "1") {
          console.log(`TEE WS health check: slot ${info.slot}`);
        }
      }
    });
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        if (!resolved) {
          reject(
            new Error(
              "TEE WS health check failed (no slot notifications). Check MagicBlock WS connectivity."
            )
          );
        } else {
          resolve();
        }
      }, timeoutMs);
      const poll = () => {
        if (resolved) {
          clearTimeout(timeout);
          resolve();
          return;
        }
        setTimeout(poll, 50);
      };
      poll();
    });
    if (process.env.NEBULON_TEE_DEBUG === "1") {
      console.log("TEE WS health check: OK");
    }
    teeWsHealthCache.set(cacheKey, { expiresAt: now + 15000 });
  } finally {
    if (subscriptionId !== null) {
      try {
        await connection.removeSlotChangeListener(subscriptionId);
      } catch {
        // ignore cleanup errors
      }
    }
  }
};

const buildPermissionEndpoint = async (config, keypair) => {
  const network = (config?.network || config?.solanaNetwork || "").toLowerCase();
  const rpc = String(config?.rpcUrl || "");
  const isLocal =
    network === "localnet" ||
    rpc.includes("localhost:8899") ||
    rpc.includes("127.0.0.1:8899");
  if (isLocal) {
    return null;
  }
  const base = normalizeEndpoint(
    config.ephemeralPermissionEndpoint || "https://tee.magicblock.app"
  );
  if (base.includes("localhost") || base.includes("127.0.0.1")) {
    return null;
  }
  try {
    const auth = await getAuthToken(
      base,
      keypair.publicKey,
      (message) => nacl.sign.detached(message, keypair.secretKey)
    );
    return `${base}?token=${auth.token}`;
  } catch (error) {
    console.warn("Permission token fetch failed. Skipping permission checks.");
    return base;
  }
};

const waitForPermissionActive = async (config, keypair, pda, label) => {
  const network = (config?.network || config?.solanaNetwork || "").toLowerCase();
  const rpc = String(config?.rpcUrl || "");
  if (
    network === "localnet" ||
    rpc.includes("localhost:8899") ||
    rpc.includes("127.0.0.1:8899")
  ) {
    return;
  }
  const endpoint = await buildPermissionEndpoint(config, keypair);
  if (!endpoint) {
    return;
  }
  try {
    const ready = await waitUntilPermissionActive(endpoint, pda, 20_000);
    if (ready) {
      return;
    }
    const status = await getPermissionStatus(endpoint, pda).catch(() => null);
    const state = status?.status || "unknown";
    throw new Error(
      `${label} permission is not active yet (status: ${state}). Try again in a few seconds.`
    );
  } catch (error) {
    console.warn(
      `Warning: permission check failed for ${label}. Proceeding without confirmation.`
    );
  }
};

const getDelegationValidator = async (config) => {
  const endpoint = (config.ephemeralProviderUrl || "").toLowerCase();
  if (endpoint.includes("localhost") || endpoint.includes("127.0.0.1")) {
    return LOCAL_VALIDATOR_IDENTITY;
  }
  if (endpoint.includes("router")) {
    if (cachedValidator && cachedValidatorEndpoint === endpoint) {
      return cachedValidator;
    }
    const router = new ConnectionMagicRouter(config.ephemeralProviderUrl, {
      wsEndpoint: config.ephemeralWsUrl || undefined,
    });
    const closest = await router.getClosestValidator();
    cachedValidator = new PublicKey(closest.pubkey || closest.validator || closest);
    cachedValidatorEndpoint = endpoint;
    return cachedValidator;
  }
  if (config.ephemeralValidatorIdentity) {
    return new PublicKey(config.ephemeralValidatorIdentity);
  }
  return null;
};

const formatCreatedAt = (value) => {
  if (!value) {
    return "n/a";
  }
  const date = new Date(value * 1000);
  if (Number.isNaN(date.getTime())) {
    return "n/a";
  }
  return date.toISOString().replace("T", " ").slice(0, 19);
};

const trimPubkey = (value) =>
  value ? `${value.slice(0, 4)}...${value.slice(-4)}` : "n/a";

const formatParticipant = (label, handle, wallet, selfWallet) => {
  const tag = handle ? `@${handle}` : "unknown";
  const suffix = wallet === selfWallet ? " (YOU)" : "";
  return `${label}: ${tag} (${trimPubkey(wallet)})${suffix}`;
};

const formatSignerLabel = (label, handle, wallet) => {
  const tag = handle ? `@${handle}` : "unknown";
  return `${label}: ${tag} (${trimPubkey(wallet)})`;
};

const ensureEditableContract = (contract) => {
  if (contract.status !== "negotiating") {
    console.error("Contract terms/milestones are locked.");
    process.exit(1);
  }
  if (contract.client_signed_at || contract.contractor_signed_at) {
    console.error("Contract is already signed. Terms and milestones are immutable.");
    if (contract.client_signed_at) {
      console.error(
        `Signed by customer: ${formatSignerLabel(
          "Customer",
          contract.client_handle,
          contract.client_wallet
        )}`
      );
    }
    if (contract.contractor_signed_at) {
      console.error(
        `Signed by service provider: ${formatSignerLabel(
          "Service Provider",
          contract.contractor_handle,
          contract.contractor_wallet
        )}`
      );
    }
    process.exit(1);
  }
};

const ensureContractPhase = (contract, allowed, nextHint) => {
  if (allowed.includes(contract.status)) {
    return;
  }
  console.error(`Invalid command for current phase. [Current_phase : ${contract.status}]`);
  process.exit(1);
};

const ensureEscrowUndelegated = async (config, keypair, escrowPda) => {
  const { connection } = getProgram(config, keypair);
  const info = await connection.getAccountInfo(escrowPda, "confirmed");
  if (!info || !info.owner || !info.owner.equals(DELEGATION_PROGRAM_ID)) {
    return;
  }
  const { programId } = getProgram(config, keypair);
  const { program: erProgram } = await getEphemeralProgram(config, keypair);
  await erProgram.methods
    .undelegateEscrow()
    .accounts({
      payer: keypair.publicKey,
      escrow: escrowPda,
      magicProgram: MAGIC_PROGRAM_ID,
      magicContext: MAGIC_CONTEXT_ID,
    })
    .signers([keypair])
    .rpc({ skipPreflight: true });
};

const ensureEscrowOwnedByProgramL1 = async (config, keypair, escrowPda) => {
  const { connection, programId } = getProgram(config, keypair);
  const info = await connection.getAccountInfo(escrowPda, "confirmed");
  if (!info || !info.owner) {
    console.error("Escrow not found on-chain.");
    return false;
  }
  if (info.owner.equals(DELEGATION_PROGRAM_ID)) {
    console.error(
      "Escrow is delegated to MagicBlock (PER). L1 MODE cannot modify it while delegated."
    );
    console.error(
      "Switch back to PER mode or wait for TEE availability and run `nebulon contract <id> sync` to undelegate."
    );
    return false;
  }
  if (!info.owner.equals(programId)) {
    console.error("Escrow is owned by an unexpected program.");
    console.error(`Owner: ${info.owner.toBase58()}`);
    return false;
  }
  return true;
};

const buildPrivacyContext = (scope, contractId, index) => {
  const tail = index === undefined ? "" : `:${index}`;
  return `nebulon:${scope}:v1:${contractId}${tail}`;
};

const getContractPrivacyKey = async (config, contractId, wallet) => {
  const keypair = ensureContractKeypair(config, contractId);
  const keys = await getContractKeys(
    config.backendUrl,
    config.auth.token,
    contractId
  );
  const entries = Array.isArray(keys.keys) ? keys.keys : [];
  const peer = entries.find((entry) => entry.wallet !== wallet);
  if (!peer || !peer.public_key) {
    throw new Error("privacy_key_pending");
  }
  return deriveContractKey(keypair.secretKey, peer.public_key, contractId);
};

const encryptTermsPayload = (key, contractId, deadline, totalPayment) => {
  const payload = JSON.stringify({
    deadline: deadline || null,
    totalPayment: totalPayment || null,
  });
  return encryptPayload(key, payload, buildPrivacyContext("terms", contractId));
};

const decryptTermsPayload = (key, contractId, encrypted) => {
  const plaintext = decryptPayload(
    key,
    encrypted,
    buildPrivacyContext("terms", contractId)
  );
  const parsed = JSON.parse(plaintext);
  return {
    deadline: parsed.deadline || null,
    totalPayment: parsed.totalPayment || null,
  };
};

const encryptMilestonePayload = (key, contractId, index, title) => {
  const payload = JSON.stringify({ title });
  return encryptPayload(
    key,
    payload,
    buildPrivacyContext("milestone", contractId, index)
  );
};

const decryptMilestonePayload = (key, contractId, index, encrypted) => {
  const plaintext = decryptPayload(
    key,
    encrypted,
    buildPrivacyContext("milestone", contractId, index)
  );
  const parsed = JSON.parse(plaintext);
  return parsed.title || "";
};

const getMilestoneLabel = (milestone) => {
  if (!milestone) {
    return "(untitled)";
  }
  if (milestone.title) {
    return milestone.title;
  }
  if (milestone.details && !isEncryptedPayload(milestone.details)) {
    return milestone.details;
  }
  if (milestone.details && isEncryptedPayload(milestone.details)) {
    return "(encrypted)";
  }
  return "(untitled)";
};

const updateContractIfNegotiating = async (config, contract, payload) => {
  if (contract.status !== "negotiating") {
    return false;
  }
  try {
    await updateContract(config.backendUrl, config.auth.token, contract.id, payload);
    return true;
  } catch (error) {
    if (error?.message === "invalid_status") {
      return false;
    }
    throw error;
  }
};

const updateContractMilestones = async (config, contract, milestones) => {
  try {
    await updateContract(config.backendUrl, config.auth.token, contract.id, {
      milestones,
    });
    return true;
  } catch (error) {
    if (error?.message === "invalid_status") {
      return false;
    }
    throw error;
  }
};

const formatUsdc = (amountBase) => {
  const raw = BigInt(amountBase || 0);
  const whole = raw / 1_000_000n;
  const fraction = (raw % 1_000_000n).toString().padStart(6, "0");
  return `${whole.toString()}.${fraction}`;
};

const printTxLogs = async (error) => {
  if (!error) {
    return;
  }
  if (Array.isArray(error.logs) && error.logs.length) {
    console.error("Transaction logs:");
    error.logs.forEach((line) => console.error(line));
    return;
  }
  if (typeof error.getLogs === "function") {
    try {
      const logs = await error.getLogs();
      if (Array.isArray(logs) && logs.length) {
        console.error("Transaction logs:");
        logs.forEach((line) => console.error(line));
      }
    } catch {
      // ignore log fetch failures
    }
  }
};

const parseAmountInput = (value) => {
  const trimmed = String(value || "").trim();
  const cleaned = trimmed
    .toLowerCase()
    .replace(/usdc/g, "")
    .replace(/\\s+/g, "")
    .replace(/[$,_]/g, "")
    .replace(/,/g, "");
  if (!cleaned || !/^\d+(\.\d+)?$/.test(cleaned)) {
    throw new Error("Invalid amount.");
  }
  const [wholePart, fracPart = ""] = cleaned.split(".");
  if (fracPart.length > 6) {
    throw new Error("Amount supports up to 6 decimals.");
  }
  const normalized = fracPart.padEnd(6, "0");
  const base = BigInt(wholePart) * 1_000_000n + BigInt(normalized || "0");
  return {
    base,
    display: `${formatUsdc(base)} USDC`,
  };
};

const formatRelativeSeconds = (seconds) => {
  const abs = Math.abs(seconds);
  if (abs % 86400 === 0) {
    return `${abs / 86400}d`;
  }
  if (abs % 3600 === 0) {
    return `${abs / 3600}h`;
  }
  if (abs % 60 === 0) {
    return `${abs / 60}m`;
  }
  return `${abs}s`;
};

const parseDeadlineInput = (value) => {
  const trimmed = (value || "").trim();
  if (!trimmed) {
    throw new Error("Deadline required.");
  }
  const relativeMatch = trimmed.match(/^(\d+)([smhd])$/i);
  if (relativeMatch) {
    const qty = Number(relativeMatch[1]);
    const unit = relativeMatch[2].toLowerCase();
    const seconds =
      unit === "d"
        ? qty * 86400
        : unit === "h"
          ? qty * 3600
          : unit === "m"
            ? qty * 60
            : qty;
    return {
      deadline: new anchor.BN(seconds).neg(),
      label: `${formatRelativeSeconds(seconds)} from funding`,
      kind: "relative",
    };
  }

  if (/^\d+$/.test(trimmed)) {
    const seconds = Number(trimmed);
    if (!Number.isFinite(seconds)) {
      throw new Error("Invalid deadline.");
    }
    return {
      deadline: new anchor.BN(seconds),
      label: new Date(seconds * 1000)
        .toISOString()
        .replace("T", " ")
        .slice(0, 19),
      kind: "absolute",
    };
  }

  const parsed = new Date(trimmed);
  if (!Number.isNaN(parsed.getTime())) {
    const seconds = Math.floor(parsed.getTime() / 1000);
    return {
      deadline: new anchor.BN(seconds),
      label: parsed.toISOString().replace("T", " ").slice(0, 19),
      kind: "absolute",
    };
  }

  throw new Error("Invalid deadline format.");
};

const formatDeadlineValue = (deadline) => {
  if (deadline === null || deadline === undefined) {
    return "n/a";
  }
  const value = Number(deadline);
  if (!Number.isFinite(value) || value === 0) {
    return "n/a";
  }
  if (value < 0) {
    return `${formatRelativeSeconds(value)} from funding`;
  }
  return new Date(value * 1000)
    .toISOString()
    .replace("T", " ")
    .slice(0, 19);
};

const buildTermsHash = (deadline, payment) => {
  const payload = `deadline:${deadline ?? ""}|payment:${payment ?? ""}`;
  return textToHash(payload);
};

const buildTermsHashHex = (deadline, payment) =>
  Buffer.from(buildTermsHash(deadline, payment)).toString("hex");

const parsePublicKey = (value, label) => {
  if (!value) {
    console.error(`Missing ${label} address.`);
    process.exit(1);
  }
  try {
    if (value instanceof PublicKey) {
      return value;
    }
    if (value?.toBase58) {
      return new PublicKey(value.toBase58());
    }
    if (Buffer.isBuffer(value) || value instanceof Uint8Array) {
      return new PublicKey(value);
    }
    return new PublicKey(String(value));
  } catch (error) {
    console.error(`Invalid ${label} address: ${String(value)}`);
    process.exit(1);
  }
};

const getExecutionMode = (contract) => {
  const mode = (contract?.execution_mode || contract?.executionMode || "per")
    .toString()
    .toLowerCase();
  return mode === "l1" ? "l1" : "per";
};

const isL1Mode = (contract) => getExecutionMode(contract) === "l1";

const ensureExecutionMode = async (config, contract, keypair, options = {}) => {
  if (isL1Mode(contract)) {
    config.__l1_mode = true;
    return "l1";
  }
  config.__l1_mode = false;
  if (isLocalnetConfig(config)) {
    config.__l1_mode = false;
    return "per";
  }
  const check = await checkTeeAvailability(config, keypair, {
    timeoutMs: 4000,
  });
  if (check.ok) {
    config.__l1_mode = false;
    return "per";
  }
  console.warn("Warning: MagicBlock TEE is not available from this location.");
  console.warn(
    "You can proceed in L1 MODE (no privacy, but functional on-chain flow)."
  );
  const proceed = await confirmAction(
    options.confirm,
    "Enable L1 MODE for this contract? yes/no"
  );
  if (!proceed) {
    console.log("Continuing without L1 mode (TEE may still fail).");
    config.__l1_mode = false;
    return "per";
  }
  await updateContract(config.backendUrl, config.auth.token, contract.id, {
    executionMode: "l1",
  });
  contract.execution_mode = "l1";
  config.__l1_mode = true;
  console.log("L1 MODE enabled for this contract.");
  return "l1";
};

const feeFromGross = (amount) => (amount * FEE_BPS) / BPS_DENOMINATOR;

const netFromGross = (amount) => amount - feeFromGross(amount);

const grossFromNet = (amount) => {
  const denom = BPS_DENOMINATOR - FEE_BPS;
  return (amount * BPS_DENOMINATOR + denom - 1n) / denom;
};

const normalizeHashBytes = (value) => {
  if (!value) {
    return Buffer.alloc(32);
  }
  if (Buffer.isBuffer(value)) {
    return value;
  }
  if (value instanceof Uint8Array) {
    return Buffer.from(value);
  }
  if (Array.isArray(value)) {
    return Buffer.from(value);
  }
  return Buffer.from(String(value), "utf8").subarray(0, 32);
};

const buildMilestonesHash = (milestones) => {
  const hash = crypto.createHash("sha256");
  const ordered = [...milestones].sort((a, b) => a.index - b.index);
  ordered.forEach((milestone) => {
    hash.update(Buffer.from([milestone.index]));
    hash.update(normalizeHashBytes(milestone.descriptionHash));
  });
  return hash.digest();
};

const resolveTermsDeadline = (deadline, fundedAt) => {
  const value = Number(deadline);
  if (!Number.isFinite(value)) {
    return null;
  }
  if (value > 0) {
    return value;
  }
  const funded = Number(fundedAt || 0);
  if (!funded) {
    return null;
  }
  return funded + Math.abs(value);
};

const formatPrivateMilestoneStatus = (status) => {
  switch (status) {
    case 0:
      return "created";
    case 1:
      return "submitted";
    case 2:
      return "rejected";
    case 3:
      return "paid";
    case 4:
      return "disabled";
    default:
      return "unknown";
  }
};

const isRemoteSubscriptionError = (error) => {
  const message = (error?.message || "").toLowerCase();
  return (
    message.includes("remote account provider") ||
    message.includes("failed to manage subscriptions") ||
    message.includes("accountsubscriptionstaskfailed") ||
    message.includes("magicblock-0 disconnected")
  );
};

const getPrivateMilestoneStatus = async (
  config,
  contract,
  keypair,
  walletKey,
  index
) => {
  const { program, programId } = getProgram(config, keypair);
  const escrowPda = new PublicKey(contract.escrow_pda);
  if (isL1Mode(contract)) {
    const milestones = await fetchPublicMilestones(
      program,
      escrowPda,
      programId,
      [index]
    );
    return milestones[0];
  }
  const { program: erProgram, sessionSigner, sessionPda } =
    await getPerProgramBundle(config, keypair, programId, program.provider);
  const milestones = await fetchPrivateMilestones(
    erProgram,
    escrowPda,
    programId,
    [index]
  );
  return milestones[0];
};

const getRole = (contract, wallet) => {
  if (!contract) {
    return "unknown";
  }
  if (contract.client_wallet === wallet) {
    return "client";
  }
  if (contract.contractor_wallet === wallet) {
    return "contractor";
  }
  if (contract.issuer_wallet === wallet) {
    return "issuer";
  }
  return "other";
};

const truncateField = (value, width) => {
  const text = String(value);
  if (text.length <= width) {
    return text;
  }
  if (width <= 1) {
    return text.slice(0, width);
  }
  return `${text.slice(0, width - 1)}…`;
};

const printContracts = (items, options = {}) => {
  if (!items.length) {
    console.log("No contracts found.");
    return;
  }
  if (options.fullFields) {
    console.log(
      "#  Contract ID                           Escrow PDA                                   Role       Status                         Created"
    );
  } else {
    const header = [
      "#".padEnd(3, " "),
      "Contract ID".padEnd(12, " "),
      "Escrow PDA".padEnd(10, " "),
      "Role".padEnd(10, " "),
      "Status".padEnd(30, " "),
      "Created",
    ];
    console.log(header.join(" "));
  }
  items.forEach((item, index) => {
    const full = Boolean(options.fullFields);
    const idField = full ? item.id : truncateField(item.id, 12);
    const escrowField = full
      ? item.escrowPda || "n/a"
      : truncateField(item.escrowPda || "n/a", 10);
    const roleField = item.role;
    const statusField = item.status;
    const row = [
      String(index + 1).padEnd(3, " "),
      String(idField).padEnd(12, " "),
      String(escrowField).padEnd(10, " "),
      String(roleField).padEnd(10, " "),
      String(statusField).padEnd(30, " "),
      item.createdAt,
    ];
    console.log(row.join(" "));
  });
};

const ensureHosted = async (config) => {
  if (config.mode !== "hosted") {
    console.error("Direct mode contract commands are not implemented yet.");
    process.exit(1);
  }
  try {
    await ensureHostedSession(config, { quiet: true, requireHandle: true });
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
};

const getWalletContext = (config) => {
  if (!config.activeWallet) {
    throw new Error("No active wallet. Run: nebulon init");
  }
  const keypair = loadWalletKeypair(config, config.activeWallet);
  return {
    keypair,
    wallet: keypair.publicKey.toBase58(),
    walletKey: keypair.publicKey,
  };
};

const getContractsForListing = (contracts) =>
  contracts.filter((contract) => !EXCLUDE_INVITE_STATUSES.has(contract.status));

const resolveContractFromList = (contracts, target) => {
  const list = getContractsForListing(contracts);
  const idx = Number.parseInt(target, 10);
  if (!Number.isNaN(idx)) {
    return list[idx - 1] || null;
  }
  if (target.length === 44) {
    return list.find((contract) => contract.escrow_pda === target) || null;
  }
  return list.find((contract) => contract.id === target) || null;
};

const confirmAction = async (skip, message) => {
  if (skip) {
    return true;
  }
  const normalize = (value) => {
    const lower = String(value || "").trim().toLowerCase();
    if (["yes", "y"].includes(lower)) {
      return true;
    }
    if (["no", "n"].includes(lower)) {
      return false;
    }
    return null;
  };
  const answer = await prompt({
    type: "input",
    name: "decision",
    message,
    initial: "yes",
    validate: (value) =>
      normalize(value) === null ? "Type yes or no." : true,
  });
  return normalize(answer.decision);
};

const resolveContract = async (config, target) => {
  const result = await getContracts(config.backendUrl, config.auth.token);
  const contracts = Array.isArray(result.contracts) ? result.contracts : [];
  const match = resolveContractFromList(contracts, target);
  if (!match) {
    return null;
  }
  const detail = await getContract(config.backendUrl, config.auth.token, match.id);
  const contract = detail.contract || match;
  const hydrated = { ...contract };
  if (!contract.terms_encrypted && !Array.isArray(contract.milestones)) {
    return hydrated;
  }
  const { wallet } = getWalletContext(config);
  try {
    const key = await getContractPrivacyKey(config, contract.id, wallet);
    hydrated.privacyReady = true;
    if (contract.terms_encrypted) {
      const terms = decryptTermsPayload(
        key,
        contract.id,
        contract.terms_encrypted
      );
      hydrated.deadline = terms.deadline;
      hydrated.total_payment = terms.totalPayment;
    }
    if (Array.isArray(contract.milestones)) {
      hydrated.milestones = contract.milestones.map((milestone) => {
        const next = { ...milestone };
        if (next.details && isEncryptedPayload(next.details)) {
          try {
            next.title = decryptMilestonePayload(
              key,
              contract.id,
              next.index,
              next.details
            );
          } catch {
            next.title = null;
          }
        }
        return next;
      });
    }
  } catch (error) {
    hydrated.privacyReady = false;
  }
  return hydrated;
};

const renderContractSummary = (contract, selfWallet) => {
  const customer = formatParticipant(
    "Customer",
    contract.client_handle,
    contract.client_wallet,
    selfWallet
  );
  const provider = formatParticipant(
    "Service Provider",
    contract.contractor_handle,
    contract.contractor_wallet,
    selfWallet
  );
  console.log(`Contract ID: ${contract.id}`);
  console.log(customer);
  console.log(provider);
};

const renderBalances = async (config, walletKey, mintAddress) => {
  console.log("-Balances-");
  try {
    const connection = getConnection(config.rpcUrl);
    const mintKey = toPublicKey(mintAddress);
    const [sol, usdc] = await Promise.all([
      getSolBalance(connection, walletKey),
      getTokenBalance(connection, walletKey, mintKey),
    ]);
    console.log(`SOL : ${formatAmount(sol, 6)} SOL`);
    console.log(`USDC : ${formatAmount(usdc, 6)} USDC`);
    console.log("");
    return { sol, usdc };
  } catch (error) {
    console.log("SOL : unavailable");
    console.log("USDC : unavailable");
    console.log("");
    return null;
  }
};

const ensureSolBalance = (balances) => {
  if (!balances) {
    return true;
  }
  if (balances.sol <= 0) {
    console.error("Insufficient SOL balance to perform this action.");
    return false;
  }
  return true;
};

const renderBalancesOrAbort = async (config, walletKey, mintAddress) => {
  const balances = await renderBalances(config, walletKey, mintAddress);
  return ensureSolBalance(balances);
};

const renderMilestones = (milestones) => {
  if (!milestones || !milestones.length) {
    console.log("(No milestones)");
    return;
  }
  milestones.forEach((milestone, idx) => {
    const label = getMilestoneLabel(milestone);
    console.log(`${idx + 1}) ${label}`);
  });
};

const ensureSessionSigner = (config, wallet) => {
  config.sessions = config.sessions || {};
  if (config.sessions[wallet] && config.sessions[wallet].secretKey) {
    return Keypair.fromSecretKey(
      Uint8Array.from(config.sessions[wallet].secretKey)
    );
  }
  const signer = Keypair.generate();
  config.sessions[wallet] = {
    secretKey: Array.from(signer.secretKey),
  };
  saveConfig(config);
  return signer;
};

const deriveSessionTokenPda = (
  programId,
  sessionProgramId,
  signer,
  authority
) =>
  PublicKey.findProgramAddressSync(
    [
      Buffer.from("session_token"),
      programId.toBytes(),
      signer.toBytes(),
      authority.toBytes(),
    ],
    sessionProgramId
  )[0];

const ensureSessionToken = async (config, provider, programId, authorityKey) => {
  const sessionManager = new SessionTokenManager(
    provider.wallet,
    provider.connection
  );
  let sessionSigner = ensureSessionSigner(config, authorityKey.toBase58());
  const sessionProgramId = sessionManager.program.programId;
  let sessionPda = deriveSessionTokenPda(
    programId,
    sessionProgramId,
    sessionSigner.publicKey,
    authorityKey
  );
  const now = Math.floor(Date.now() / 1000);
  let existing = null;
  try {
    existing = await sessionManager.get(sessionPda);
  } catch {
    existing = null;
  }

  const existingUntil = existing?.validUntil ?? existing?.valid_until ?? null;
  if (existingUntil && Number(existingUntil) > now + 30) {
    return { sessionSigner, sessionPda };
  }

  if (existing) {
    try {
      const revokeTx = await sessionManager.program.methods
        .revokeSession()
        .accounts({
          sessionToken: sessionPda,
          authority: authorityKey,
          systemProgram: SystemProgram.programId,
        })
        .transaction();
      await provider.sendAndConfirm(revokeTx, []);
    } catch {
      sessionSigner = Keypair.generate();
      config.sessions[authorityKey.toBase58()] = {
        secretKey: Array.from(sessionSigner.secretKey),
      };
      saveConfig(config);
      sessionPda = deriveSessionTokenPda(
        programId,
        sessionProgramId,
        sessionSigner.publicKey,
        authorityKey
      );
    }
  }

  const validUntil = new anchor.BN(now + 3600);
  const tx = await sessionManager.program.methods
    .createSession(true, validUntil, new anchor.BN(0))
    .accounts({
      targetProgram: programId,
      sessionSigner: sessionSigner.publicKey,
      authority: authorityKey,
    })
    .transaction();
  await provider.sendAndConfirm(tx, [sessionSigner]);

  return { sessionSigner, sessionPda };
};

const getSessionContext = async (config, keypair, program) => {
  if (isLocalnetConfig(config)) {
    const { sessionSigner, sessionPda } = await ensureSessionToken(
      config,
      program.provider,
      program.programId,
      keypair.publicKey
    );
    return { signer: sessionSigner, sessionPda, payer: sessionSigner.publicKey };
  }
  return { signer: keypair, sessionPda: null, payer: keypair.publicKey };
};

const getPerProgramBundle = async (config, keypair, programId, provider) => {
  if (isLocalnetConfig(config)) {
    const { sessionSigner, sessionPda } = await ensureSessionToken(
      config,
      provider,
      programId,
      keypair.publicKey
    );
    const { program } = getProgram(config, sessionSigner, { useEphemeral: true });
    return { program, sessionSigner, sessionPda };
  }
  const { program } = await getEphemeralProgram(config, keypair);
  return { program, sessionSigner: keypair, sessionPda: null };
};

const isAlreadyExistsError = (error) => {
  const message = (error?.message || "").toLowerCase();
  return (
    message.includes("already in use") ||
    message.includes("exists") ||
    message.includes("already initialized")
  );
};

const ensurePermission = async (
  _config,
  program,
  keypair,
  permissionedAccount,
  members
) => {
  try {
    await program.methods
      .createPermission(members.accountType, members.entries)
      .accountsPartial({
        payer: keypair.publicKey,
        permissionedAccount,
        permission: permissionPdaFromAccount(permissionedAccount),
        permissionProgram: PERMISSION_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .signers([keypair])
      .rpc();
    return true;
  } catch (error) {
    if (isAlreadyExistsError(error)) {
      return false;
    }
    throw error;
  }
};

const ensureDelegatedPermission = async (
  config,
  provider,
  keypair,
  permissionedAccount
) => {
  if (config && config.__l1_mode) {
    return;
  }
  const permissionPda = permissionPdaFromAccount(permissionedAccount);
  const info = await provider.connection.getAccountInfo(
    permissionPda,
    "confirmed"
  );
  if (info && info.owner.equals(DELEGATION_PROGRAM_ID)) {
    return;
  }
  if (info && !info.owner.equals(PERMISSION_PROGRAM_ID)) {
    throw new Error(
      `Permission ${permissionPda.toBase58()} is owned by ${info.owner.toBase58()}, expected ${PERMISSION_PROGRAM_ID.toBase58()}.`
    );
  }
  const validator = await getDelegationValidator(config);
  const ix = createDelegatePermissionInstruction({
    payer: keypair.publicKey,
    validator,
    permissionedAccount: [permissionedAccount, false],
    authority: [keypair.publicKey, true],
  });
  const permissionMeta = ix.keys.find((key) =>
    key.pubkey.equals(permissionedAccount)
  );
  if (permissionMeta) {
    permissionMeta.isWritable = true;
  }
  const tx = new Transaction().add(ix);
  try {
    await provider.sendAndConfirm(tx, [keypair]);
  } catch (error) {
    if (!isAlreadyExistsError(error)) {
      throw error;
    }
  }
};

const ensureDelegatedAccount = async (
  config,
  program,
  keypair,
  accountType,
  pda
) => {
  if (config && config.__l1_mode) {
    return;
  }
  const info = await program.provider.connection.getAccountInfo(pda, "confirmed");
  if (info && info.owner.equals(DELEGATION_PROGRAM_ID)) {
    return;
  }
  const isPerVault = accountType && Object.prototype.hasOwnProperty.call(accountType, "perVault");
  if (
    info &&
    !info.owner.equals(program.programId) &&
    !(isPerVault && info.owner.equals(SystemProgram.programId))
  ) {
    throw new Error(
      `Account ${pda.toBase58()} is owned by ${info.owner.toBase58()}, expected ${program.programId.toBase58()}.`
    );
  }
  try {
    const validator = await getDelegationValidator(config);
    const remainingAccounts = validator
      ? [{ pubkey: validator, isWritable: false, isSigner: false }]
      : [];
    await program.methods
      .delegateAccount(accountType)
      .accounts({
        payer: keypair.publicKey,
        pda,
      })
      .remainingAccounts(remainingAccounts)
      .signers([keypair])
      .rpc();
  } catch (error) {
    if (!isAlreadyExistsError(error)) {
      throw error;
    }
  }
};

const ensureDelegatedEscrow = async (
  config,
  program,
  keypair,
  escrowId,
  escrowPda,
  client
) => {
  if (config && config.__l1_mode) {
    return;
  }
  const info = await program.provider.connection.getAccountInfo(
    escrowPda,
    "confirmed"
  );
  if (info && info.owner.equals(DELEGATION_PROGRAM_ID)) {
    return;
  }
  if (info && !info.owner.equals(program.programId)) {
    throw new Error(
      `Escrow ${escrowPda.toBase58()} is owned by ${info.owner.toBase58()}, expected ${program.programId.toBase58()}.`
    );
  }
  try {
    const validator = await getDelegationValidator(config);
    const remainingAccounts = validator
      ? [{ pubkey: validator, isWritable: false, isSigner: false }]
      : [];
    await program.methods
      .delegateEscrow(new anchor.BN(escrowId.toString()))
      .accounts({
        payer: keypair.publicKey,
        pda: escrowPda,
        client,
      })
      .remainingAccounts(remainingAccounts)
      .signers([keypair])
      .rpc();
  } catch (error) {
    if (!isAlreadyExistsError(error)) {
      throw error;
    }
  }
};

const buildMembers = (contract) => {
  const flags = AUTHORITY_FLAG | TX_LOGS_FLAG;
  return {
    entries: [
      { flags, pubkey: new PublicKey(contract.client_wallet) },
      { flags, pubkey: new PublicKey(contract.contractor_wallet) },
    ],
  };
};

const ensureAta = async (connection, payer, owner, mint) => {
  const ata = await getAssociatedTokenAddress(mint, owner, true);
  try {
    await getAccount(connection, ata);
    return ata;
  } catch (error) {
    await createAssociatedTokenAccountIdempotent(
      connection,
      payer,
      mint,
      owner,
      { commitment: "confirmed" },
      TOKEN_PROGRAM_ID,
      undefined,
      true
    );
    return ata;
  }
};

const getMilestonesForContract = async (connection, programId, escrowPda, count) => {
  const milestones = [];
  for (let index = 0; index < count; index += 1) {
    const pda = deriveMilestonePda(escrowPda, index, programId);
    const state = await getMilestoneState(connection, programId, pda);
    if (state) {
      milestones.push({ index, pda, state });
    } else {
      milestones.push({ index, pda, state: null });
    }
  }
  return milestones;
};

const runContractsShow = async (scope, options = {}) => {
  const config = loadConfig();
  await ensureHosted(config);

  const { keypair } = getWalletContext(config);
  const wallet = keypair.publicKey.toBase58();

  const target = (scope || "").trim().toLowerCase();
  const result = await getContracts(config.backendUrl, config.auth.token);
  const contracts = Array.isArray(result.contracts) ? result.contracts : [];

  if (target === "disputed") {
    if (config.auth.role !== "judge") {
      console.error("Only the judge can list disputed contracts.");
      return;
    }
    const items = contracts
      .filter((contract) => contract.status === "dispute_open")
      .map((contract) => ({
        id: contract.id,
        escrowPda: contract.escrow_pda || "n/a",
        role: getRole(contract, wallet),
        status: contract.status,
        createdAt: formatCreatedAt(contract.created_at),
      }));
    printContracts(items, options);
    return;
  }

  if (target === "active") {
    const items = contracts
      .filter((contract) => ACTIVE_STATUSES.has(contract.status))
      .map((contract) => ({
        id: contract.id,
        escrowPda: contract.escrow_pda || "n/a",
        role: getRole(contract, wallet),
        status: contract.status,
        createdAt: formatCreatedAt(contract.created_at),
      }));
    printContracts(items, options);
    return;
  }

  if (target === "all" || !target) {
    const items = getContractsForListing(contracts).map((contract) => ({
      id: contract.id,
      escrowPda: contract.escrow_pda || "n/a",
      role: getRole(contract, wallet),
      status: contract.status,
      createdAt: formatCreatedAt(contract.created_at),
    }));
    printContracts(items, options);
    return;
  }

  const match = resolveContractFromList(contracts, target);
  if (!match) {
    console.log("Contract not found.");
    return;
  }
  printContracts(
    [
    {
      id: match.id,
      escrowPda: match.escrow_pda || "n/a",
      role: getRole(match, wallet),
      status: match.status,
      createdAt: formatCreatedAt(match.created_at),
    },
    ],
    options
  );
};

const runContractsCreate = async () => {
  const config = loadConfig();
  await ensureHosted(config);

  let inviteeRole = null;
  let shareMode = null;
  let inviteeHandle = null;

  try {
    const roleAnswer = await prompt({
      type: "select",
      name: "selfRole",
      message: "Whats your role on this contract?",
      choices: ROLE_CHOICES,
    });
    inviteeRole = roleAnswer.selfRole === "client" ? "contractor" : "client";

    const shareAnswer = await prompt({
      type: "select",
      name: "share",
      message: "How would you like to share this contract?",
      choices: SHARE_CHOICES,
    });
    shareMode = shareAnswer.share;

    if (shareMode === "direct") {
      const handleAnswer = await prompt({
        type: "input",
        name: "handle",
        message: "Nebulon ID",
        validate: (value) => {
          if (!value || !value.trim()) {
            return "Nebulon ID required.";
          }
          return true;
        },
      });
      inviteeHandle = normalizeHandle(handleAnswer.handle);
    }
  } catch (error) {
    if (isPromptCancel(error)) {
      console.log("Contract creation canceled.");
      return;
    }
    throw error;
  }

  const payload = { inviteeRole };
  if (inviteeHandle) {
    payload.inviteeHandle = inviteeHandle;
  }

  const result = await createInvite(config.backendUrl, config.auth.token, payload);

  const keypair = ensureContractKeypair(config, result.contractId);
  console.log("Setting up privacy keys...");
  try {
    await setContractKey(
      config.backendUrl,
      config.auth.token,
      result.contractId,
      keypair.publicKey
    );
    const keys = await getContractKeys(
      config.backendUrl,
      config.auth.token,
      result.contractId
    );
    const count = Array.isArray(keys.keys) ? keys.keys.length : 0;
    if (count > 1) {
      console.log("Privacy key exchange complete.");
    } else {
      console.log("Privacy key registered. Awaiting counterparty.");
    }
  } catch (error) {
    console.log("Privacy key setup pending. Try again after invite acceptance.");
  }

  console.log("Contract invite created.");
  console.log(`Contract ID: ${result.contractId}`);

  if (shareMode === "direct") {
    console.log(`Invite sent to @${inviteeHandle}.`);
  }
  if (shareMode === "link") {
    console.log(`Invite link: ${result.inviteUrl}`);
    console.log(`Contract code: ${result.token}`);
  }
  if (shareMode === "code") {
    console.log(`Contract code: ${result.token}`);
  }

  console.log("Invite status: pending");
  successMessage("Invite created.");
};

const runInitContract = async (config, contract, options) => {
  const { keypair, wallet, walletKey } = getWalletContext(config);
  if (!contract.client_wallet || !contract.contractor_wallet) {
    console.error("Invite not accepted yet.");
    process.exit(1);
  }
  if (contract.escrow_pda) {
    console.log("Escrow already initialized.");
    return;
  }
  if (wallet !== contract.client_wallet && wallet !== contract.contractor_wallet) {
    console.error("Only contract participants can initialize the escrow.");
    process.exit(1);
  }
  await ensureExecutionMode(config, contract, keypair, options);

  console.log("Verify data and confirm actions please.");
  renderContractSummary(contract, wallet);
  console.log("-Action-");
  console.log("Initialize contract escrow");
  console.log("");

  const balances = await renderBalances(
    config,
    walletKey,
    contract.mint || config.usdcMint
  );
  if (!ensureSolBalance(balances)) {
    return;
  }

  const proceed = await confirmAction(options.confirm, "Proceed? yes/no");
  if (!proceed) {
    console.log("Canceled.");
    return;
  }

  try {
    let step = "init";
    const { program, connection, programId } = getProgram(config, keypair);
    step = "program_info";
    const programInfo = await connection.getAccountInfo(programId);
    if (!programInfo || !programInfo.executable) {
      console.error("Nebulon program is not deployed on this network.");
      console.error(`Program ID: ${programId.toBase58()}`);
      console.error("Deploy it with `anchor deploy` and retry.");
      return;
    }
    step = "ata_program_info";
    const ataProgramInfo = await connection.getAccountInfo(
      ASSOCIATED_TOKEN_PROGRAM_ID
    );
    if (!ataProgramInfo || !ataProgramInfo.executable) {
      console.error("Associated Token Program is not available on this network.");
      console.error(
        `Program ID: ${ASSOCIATED_TOKEN_PROGRAM_ID.toBase58()}`
      );
      console.error(
        "Start localnet with the program or deploy it before initializing escrows."
      );
      return;
    }
    step = "parse_mint";
    const mint = parsePublicKey(
      contract.mint || config.usdcMint,
      "USDC mint"
    );
    step = "mint_info";
    const mintInfo = await connection.getAccountInfo(mint);
    if (!mintInfo) {
      console.error(
        "Test-USDC mint is not initialized on this network. Run `nebulon request-usdc` or create the mint first."
      );
      return;
    }
    step = "derive_keys";
    const escrowId = new anchor.BN(Date.now());
    const clientKey = parsePublicKey(contract.client_wallet, "client wallet");
    const contractorKey = parsePublicKey(contract.contractor_wallet, "contractor wallet");
    const escrowPda = deriveEscrowPda(clientKey, escrowId, programId);
    const perVaultPda = derivePerVaultPda(escrowPda, programId);
    step = "vault_token";
    const vaultToken = await getAssociatedTokenAddress(mint, escrowPda, true);

    console.log("Processing.");
    step = "create_escrow";
    const sig = await program.methods
      .createEscrow(escrowId, FEE_RECEIVER)
      .accounts({
        payer: walletKey,
        client: clientKey,
        contractor: contractorKey,
        mint,
        escrow: escrowPda,
        perVault: perVaultPda,
        vaultToken,
        tokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .signers([keypair])
      .rpc();
    console.log(`Escrow initialized. (tx: ${sig})`);

    await linkEscrow(config.backendUrl, config.auth.token, contract.id, {
      escrowPda: escrowPda.toBase58(),
      mint: mint.toBase58(),
      vaultToken: vaultToken.toBase58(),
    });
    console.log("Escrow linked to contract.");
    successMessage("Escrow initialized.");
  } catch (error) {
    const message = error?.message || "";
    if (message.includes("Expected Buffer")) {
      console.error("Expected Buffer!");
      console.error(`Debug step: ${typeof step !== "undefined" ? step : "unknown"}`);
      if (error?.stack) {
        console.error(error.stack);
      }
      return;
    }
    throw error;
  }
};

const runAddMilestone = async (config, contract, title, options) => {
  const { keypair, wallet, walletKey } = getWalletContext(config);
  ensureEditableContract(contract);
  if (!contract.escrow_pda) {
    console.error("Contract has no escrow. Unable to add milestones yet.");
    process.exit(1);
  }

  const { program, connection, programId } = getProgram(config, keypair);
  const escrowPda = new PublicKey(contract.escrow_pda);
  const escrowState = await getEscrowState(connection, programId, escrowPda);
  if (!escrowState) {
    console.error("Escrow not found on-chain.");
    process.exit(1);
  }
  if (escrowState.paidOut) {
    console.log("Funds already claimed. Contract completed successfully.");
    return;
  }

  const escrowId = escrowState.escrowId;
  const index = Array.isArray(contract.milestones)
    ? contract.milestones.length
    : 0;

  console.log("Verify data and confirm actions please.");
  renderContractSummary(contract, wallet);
  console.log("-Action-");
  console.log("Add Milestone");
  console.log(`Number : ${index + 1}`);
  console.log(`Details : \"${title}\"`);
  console.log("");
    const canProceed = await renderBalancesOrAbort(
      config,
      walletKey,
      contract.mint || config.usdcMint
    );
    if (!canProceed) {
      return;
    }
  const proceed = await confirmAction(options.confirm, "Proceed? yes/no");
  if (!proceed) {
    console.log("Canceled.");
    return;
  }

  const executionMode = await ensureExecutionMode(config, contract, keypair, options);
  const l1Mode = executionMode === "l1";

  console.log("Processing.");
  if (l1Mode) {
    const milestonePda = deriveMilestonePda(escrowPda, index, programId);
    const sig = await program.methods
      .addMilestone(new anchor.BN(escrowId.toString()), index)
      .accounts({
        actor: walletKey,
        escrow: escrowPda,
        milestone: milestonePda,
        systemProgram: SystemProgram.programId,
      })
      .signers([keypair])
      .rpc();
    console.log(`Milestone created. (tx: ${sig})`);

    const milestones = Array.isArray(contract.milestones)
      ? [...contract.milestones]
      : [];
    milestones.push({ index, details: title, status: "created" });
    const persisted = await updateContractMilestones(config, contract, milestones);
    if (!persisted) {
      console.log(
        "Warning: backend did not persist milestone status (check backend version)."
      );
    }
    successMessage("Milestone added.");
    return;
  }
  let privacyKey;
  try {
    privacyKey = await getContractPrivacyKey(config, contract.id, wallet);
  } catch (error) {
    console.error(
      "Privacy key exchange pending. Wait for the counterparty to accept."
    );
    process.exit(1);
  }
  const encryptedDetails = encryptMilestonePayload(
    privacyKey,
    contract.id,
    index,
    title
  );
  
  const encryptedBytes = Buffer.from(encryptedDetails, "utf8");
  
  // Ensure encrypted bytes fit exactly into the expected buffer size
  // Look for the error message "requires (length X) Buffer as src"
  // and set the buffer size to X bytes
  const expectedSize = 73; // From error: "requires (length 73) Buffer as src"
  const paddedBytes = Buffer.alloc(expectedSize, 0);
  encryptedBytes.copy(paddedBytes, 0, 0, Math.min(encryptedBytes.length, expectedSize));
  
  const descriptionHash = crypto
    .createHash("sha256")
    .update(encryptedDetails)
    .digest();

  const privateMilestonePda = derivePrivateMilestonePda(
    escrowPda,
    index,
    programId
  );
  await program.methods
    .initPrivateMilestoneStub(new anchor.BN(escrowId.toString()), index)
    .accounts({
      payer: walletKey,
      escrow: escrowPda,
      privateMilestone: privateMilestonePda,
      systemProgram: SystemProgram.programId,
    })
    .signers([keypair])
    .rpc();

  const members = buildMembers(contract);
  members.accountType = {
    privateMilestone: {
      escrow: escrowPda,
      index,
    },
  };
  await ensurePermission(config, program, keypair, privateMilestonePda, members);
  await ensureDelegatedPermission(
    config,
    program.provider,
    keypair,
    privateMilestonePda
  );
  await ensureDelegatedAccount(
    config,
    program,
    keypair,
    members.accountType,
    privateMilestonePda
  );

  const perVaultPda = derivePerVaultPda(escrowPda, programId);
  await ensureDelegatedAccount(
    config,
    program,
    keypair,
    { perVault: { escrow: escrowPda } },
    perVaultPda
  );
  await ensureDelegatedEscrow(
    config,
    program,
    keypair,
    escrowId,
    escrowPda,
    new PublicKey(contract.client_wallet)
  );

  const { program: erProgram, sessionSigner, sessionPda } =
    await getPerProgramBundle(config, keypair, programId, program.provider);
  const metaSig = await erProgram.methods
    .createPrivateMilestone(
      new anchor.BN(escrowId.toString()),
      index,
      Buffer.from(descriptionHash),
      paddedBytes
    )
      .accounts({
        user: walletKey,
      payer: sessionSigner.publicKey,
      sessionToken: sessionPda,
        escrow: escrowPda,
        privateMilestone: privateMilestonePda,
        perVault: perVaultPda,
        systemProgram: SystemProgram.programId,
      })
    .signers([sessionSigner])
    .rpc({ skipPreflight: true });
  console.log("Submitting Metadata...");
  console.log(`Done. (tx: ${metaSig})`);

  const milestones = Array.isArray(contract.milestones)
    ? [...contract.milestones]
    : [];
  milestones.push({ index, details: encryptedDetails, status: "created" });
  const persisted = await updateContractMilestones(config, contract, milestones);
  if (!persisted) {
    console.log(
      "Warning: backend did not persist milestone status (check backend version)."
    );
  }
  successMessage("Milestone added.");
};

const runDisableMilestone = async (config, contract, number, options) => {
  const { keypair, wallet, walletKey } = getWalletContext(config);
  if (!contract.escrow_pda) {
    console.error("Contract has no escrow. Unable to disable milestones.");
    process.exit(1);
  }
  const role = getRole(contract, wallet);
  if (role !== "client" && role !== "contractor") {
    console.error("Only contract participants can disable milestones.");
    process.exit(1);
  }
  const index = Number(number) - 1;
  if (!Number.isFinite(index) || index < 0) {
    console.error("Invalid milestone number.");
    process.exit(1);
  }
  const milestoneList = Array.isArray(contract.milestones)
    ? contract.milestones
    : [];
  const milestoneMeta = milestoneList.find((milestone) => milestone.index === index);
  if (!milestoneMeta) {
    console.error("Milestone not found.");
    console.error("Check the list with: nebulon contract <id> check milestone list");
    return;
  }
  const executionMode = await ensureExecutionMode(config, contract, keypair, options);
  const l1Mode = executionMode === "l1";
  if (l1Mode) {
    const { program, connection, programId } = getProgram(config, keypair);
    const escrowPda = new PublicKey(contract.escrow_pda);
    const escrowState = await getEscrowState(connection, programId, escrowPda);
    if (!escrowState) {
      console.error("Escrow not found on-chain.");
      process.exit(1);
    }
    const ok = await ensureEscrowOwnedByProgramL1(config, keypair, escrowPda);
    if (!ok) {
      return;
    }
    const escrowId = escrowState.escrowId;
    const milestonePda = deriveMilestonePda(escrowPda, index, programId);
    console.log("Verify data and confirm actions please.");
    renderContractSummary(contract, wallet);
    console.log("-Action-");
    console.log("Disable milestone");
    console.log(`Number : ${index + 1}`);
    const milestones = Array.isArray(contract.milestones) ? contract.milestones : [];
    const current = milestones.find((m) => m.index === index);
    console.log(`Details : \"${current ? getMilestoneLabel(current) : "unknown"}\"`);
    console.log("");
    const proceed = await confirmAction(options.confirm, "Proceed? yes/no");
    if (!proceed) {
      console.log("Canceled.");
      return;
    }
    console.log("Processing.");
    const sig = await program.methods
      .disableMilestone(new anchor.BN(escrowId.toString()), index)
      .accounts({
        actor: walletKey,
        escrow: escrowPda,
        milestone: milestonePda,
      })
      .signers([keypair])
      .rpc();
    console.log(`Milestone disabled. (tx: ${sig})`);
    const nextMilestones = milestones.map((milestone) =>
      milestone.index === index
        ? { ...milestone, status: "disabled" }
        : milestone
    );
    const persisted = await updateContractMilestones(config, contract, nextMilestones);
    if (!persisted) {
      console.log(
        "Warning: backend did not persist milestone status (check backend version)."
      );
    }
    successMessage("Milestone disabled.");
    return;
  }
  if (!config.ephemeralProviderUrl) {
    console.error(
      "Warning: MagicBlock RPC is not configured; milestone status checks may be unreliable."
    );
    console.error("Run `nebulon init` to fetch the MagicBlock endpoints.");
  }
  if (milestoneMeta.status === "ready") {
    console.error("Milestone already submitted and awaiting customer confirmation.");
    console.error("Current status: submitted");
    return;
  }
  if (milestoneMeta.status === "approved") {
    console.error("Milestone already confirmed.");
    console.error("Current status: paid");
    return;
  }
  if (milestoneMeta.status === "disabled") {
    console.error("Milestone is disabled.");
    console.error("Current status: disabled");
    return;
  }
  let currentStatus = null;
  try {
    const milestone = await getPrivateMilestoneStatus(
      config,
      contract,
      keypair,
      walletKey,
      index
    );
    currentStatus = milestone ? milestone.status : null;
  } catch (error) {
    console.error("Unable to verify milestone status.");
    process.exit(1);
  }
  const statusValue = Number(currentStatus);
  if (!Number.isFinite(statusValue)) {
    console.error("Unable to determine milestone status.");
    return;
  }
  const statusLabel = formatPrivateMilestoneStatus(statusValue);
  if (statusValue === 1) {
    console.error("Milestone already submitted and awaiting customer confirmation.");
    console.error("Current status: submitted");
    return;
  }
  if (statusValue === 3) {
    console.error("Milestone already confirmed.");
    console.error("Current status: paid");
    return;
  }
  if (statusValue === 4) {
    console.error("Milestone is disabled.");
    console.error("Current status: disabled");
    return;
  }
  if (statusValue !== 0 && statusValue !== 2) {
    console.error(`Cannot mark milestone as ready from status: ${statusLabel}`);
    return;
  }

  console.log("Verify data and confirm actions please.");
  renderContractSummary(contract, wallet);
  console.log("-Action-");
  console.log("Disable milestone");
  console.log(`Number : ${index + 1}`);
  const milestones = Array.isArray(contract.milestones) ? contract.milestones : [];
  const current = milestones.find((m) => m.index === index);
  console.log(`Details : \"${current ? getMilestoneLabel(current) : "unknown"}\"`);
  console.log("");

  const canProceed = await renderBalancesOrAbort(
    config,
    walletKey,
    contract.mint || config.usdcMint
  );
  if (!canProceed) {
    return;
  }

  const proceed = await confirmAction(options.confirm, "Proceed? yes/no");
  if (!proceed) {
    console.log("Canceled.");
    return;
  }

  console.log("Processing.");
  const sig = await updatePrivateMilestoneStatus(
    config,
    contract,
    keypair,
    walletKey,
    index,
    4
  );
  console.log(`Milestone disabled. (tx: ${sig})`);

  const nextMilestones = milestones.map((milestone) =>
    milestone.index === index
      ? { ...milestone, status: "disabled" }
      : milestone
  );
  await updateContractIfNegotiating(config, contract, {
    milestones: nextMilestones,
  });
  await runSyncFlags(config, contract, { ...options, confirm: true });
  successMessage("Milestone disabled.");
};

const ensureTermsPrepared = async (
  config,
  contract,
  keypair,
  escrowPda,
  escrowId
) => {
  const { program, programId } = getProgram(config, keypair);
  const termsPda = deriveTermsPda(escrowPda, programId);
  await program.methods
    .initPrivateTermsStub(new anchor.BN(escrowId.toString()))
    .accounts({
      payer: keypair.publicKey,
      escrow: escrowPda,
      terms: termsPda,
      systemProgram: SystemProgram.programId,
    })
    .signers([keypair])
    .rpc();

  const members = buildMembers(contract);
  members.accountType = { terms: { escrow: escrowPda } };
  await ensurePermission(config, program, keypair, termsPda, members);
  await ensureDelegatedPermission(config, program.provider, keypair, termsPda);
  await waitForPermissionActive(config, keypair, termsPda, "Terms");
  await ensureDelegatedAccount(
    config,
    program,
    keypair,
    members.accountType,
    termsPda
  );

  const perVaultPda = derivePerVaultPda(escrowPda, programId);
  await ensureDelegatedAccount(
    config,
    program,
    keypair,
    { perVault: { escrow: escrowPda } },
    perVaultPda
  );
  await ensureDelegatedEscrow(
    config,
    program,
    keypair,
    escrowId,
    escrowPda,
    new PublicKey(contract.client_wallet)
  );

  return { termsPda, perVaultPda, program, programId };
};

const submitTerms = async (
  config,
  contract,
  keypair,
  escrowPda,
  escrowId,
  totalPayment,
  deadline,
  encryptedTerms
) => {
  const { termsPda, perVaultPda, program, programId } = await ensureTermsPrepared(
    config,
    contract,
    keypair,
    escrowPda,
    escrowId
  );

  const { program: erProgram, sessionSigner, sessionPda } =
    await getPerProgramBundle(config, keypair, programId, program.provider);
  const encryptedBytes = Buffer.from(encryptedTerms || "", "utf8");
  const attemptCreate = async (forceRefresh = false) => {
    const { program } = forceRefresh
      ? await getEphemeralProgram(config, keypair, { forceRefresh: true })
      : { program: erProgram };
    return program.methods
      .createPrivateTerms(
        new anchor.BN(escrowId.toString()),
        buildTermsHash(deadline, totalPayment),
        new anchor.BN(totalPayment.toString()),
        new anchor.BN(deadline.toString()),
         encryptedBytes
      )
      .accounts({
        user: keypair.publicKey,
        payer: sessionSigner.publicKey,
        sessionToken: sessionPda,
        escrow: escrowPda,
        terms: termsPda,
        perVault: perVaultPda,
        systemProgram: SystemProgram.programId,
      })
      .signers([sessionSigner])
      .rpc({ skipPreflight: true });
  };

  const attemptCreateDirect = async () => {
    const { program: userErProgram } = await getEphemeralProgram(
      config,
      keypair,
      { forceRefresh: true }
    );
    return userErProgram.methods
      .createPrivateTerms(
        new anchor.BN(escrowId.toString()),
        buildTermsHash(deadline, totalPayment),
        new anchor.BN(totalPayment.toString()),
        new anchor.BN(deadline.toString()),
         encryptedBytes
      )
      .accounts({
        user: keypair.publicKey,
        payer: sessionSigner.publicKey,
        sessionToken: sessionPda,
        escrow: escrowPda,
        terms: termsPda,
        perVault: perVaultPda,
        systemProgram: SystemProgram.programId,
      })
      .signers([sessionSigner])
      .rpc({ skipPreflight: true });
  };

  const retries = [0, 3000, 6000];
  let lastError = null;
  for (const delay of retries) {
    if (delay) {
      await sleep(delay);
    }
    try {
      return await attemptCreate(delay > 0);
    } catch (error) {
      lastError = error;
      const message = (error?.message || "").toLowerCase();
      if (
        message.includes("writable account") ||
        message.includes("cannot be written")
      ) {
        continue;
      }
      if (isRemoteSubscriptionError(error)) {
        try {
          return await attemptCreateDirect();
        } catch (directError) {
          lastError = directError;
        }
      }
      throw error;
    }
  }
  throw lastError;
};

const submitPublicTerms = async (
  config,
  contract,
  keypair,
  escrowPda,
  escrowId,
  totalPayment,
  deadline
) => {
  const { program, programId } = getProgram(config, keypair);
  const termsPda = deriveTermsPda(escrowPda, programId);
  const ok = await ensureEscrowOwnedByProgramL1(config, keypair, escrowPda);
  if (!ok) {
    return null;
  }
  const ix = await program.methods
    .setPublicTerms(
      new anchor.BN(escrowId.toString()),
      buildTermsHash(deadline, totalPayment),
      new anchor.BN(totalPayment.toString()),
      new anchor.BN(deadline.toString())
    )
    .accounts({
      user: keypair.publicKey,
      escrow: escrowPda,
      terms: termsPda,
      systemProgram: SystemProgram.programId,
    })
    .instruction();
  ix.keys = ix.keys.map((key) => {
    if (key.pubkey.equals(escrowPda) || key.pubkey.equals(termsPda)) {
      return { ...key, isWritable: true };
    }
    return key;
  });
  const tx = new Transaction().add(ix);
  const sig = await program.provider.sendAndConfirm(tx, [keypair]);
  return sig;
};

const signPublicTermsOnChain = async (
  config,
  keypair,
  escrowPda,
  escrowId
) => {
  const { program, programId } = getProgram(config, keypair);
  const termsPda = deriveTermsPda(escrowPda, programId);
  try {
    const escrowState = await program.account.escrow.fetch(escrowPda);
    const termsState = await program.account.terms.fetch(termsPda);
    const escrowIdOnChain = escrowState.escrowId?.toString?.() || String(escrowState.escrowId);
    const expectedEscrowId = escrowId.toString();
    if (escrowIdOnChain !== expectedEscrowId) {
      console.error(
        `L1 sign precheck: escrow_id mismatch (chain=${escrowIdOnChain}, local=${expectedEscrowId})`
      );
    }
    if (termsState.escrow && termsState.escrow.toBase58) {
      const termsEscrow = termsState.escrow.toBase58();
      if (termsEscrow !== escrowPda.toBase58()) {
        console.error(
          `L1 sign precheck: terms.escrow mismatch (terms=${termsEscrow}, escrow=${escrowPda.toBase58()})`
        );
      }
    }
    if (escrowState.fundedAmount && escrowState.fundedAmount.toString) {
      const funded = escrowState.fundedAmount.toString();
      if (funded !== "0") {
        console.error(`L1 sign precheck: funded_amount is ${funded}, expected 0`);
      }
    }
    if (escrowState.fundingOk) {
      console.error("L1 sign precheck: funding_ok already true");
    }
  } catch (error) {
    console.error("L1 sign precheck failed to fetch escrow/terms.");
  }
  const ix = await program.methods
    .signPublicTerms(new anchor.BN(escrowId.toString()))
    .accounts({
      user: keypair.publicKey,
      escrow: escrowPda,
      terms: termsPda,
    })
    .instruction();
  ix.keys = ix.keys.map((key) => {
    if (key.pubkey.equals(escrowPda) || key.pubkey.equals(termsPda)) {
      return { ...key, isWritable: true };
    }
    return key;
  });
  const tx = new Transaction().add(ix);
  const sig = await program.provider.sendAndConfirm(tx, [keypair]);
  return { sig, termsPda };
};

const commitPublicTermsOnChain = async (
  config,
  keypair,
  escrowPda,
  escrowId
) => {
  const { program, programId } = getProgram(config, keypair);
  const termsPda = deriveTermsPda(escrowPda, programId);
  const ix = await program.methods
    .commitPublicTerms(new anchor.BN(escrowId.toString()))
    .accounts({
      user: keypair.publicKey,
      escrow: escrowPda,
      terms: termsPda,
    })
    .instruction();
  ix.keys = ix.keys.map((key) => {
    if (key.pubkey.equals(escrowPda) || key.pubkey.equals(termsPda)) {
      return { ...key, isWritable: true };
    }
    return key;
  });
  const tx = new Transaction().add(ix);
  return program.provider.sendAndConfirm(tx, [keypair]);
};

const fetchPublicMilestones = async (
  program,
  escrowPda,
  programId,
  indices
) => {
  const milestones = [];
  for (const index of indices) {
    const pda = deriveMilestonePda(escrowPda, index, programId);
    try {
      const state = await program.account.milestone.fetch(pda);
      milestones.push({ index, status: Number(state.status), pda });
    } catch {
      milestones.push({ index, status: null, pda });
    }
  }
  return milestones;
};

const runAddTerm = async (config, contract, field, value, options) => {
  const { keypair, wallet, walletKey } = getWalletContext(config);
  ensureEditableContract(contract);
  if (!contract.escrow_pda) {
    console.error("Contract has no escrow. Unable to edit terms.");
    process.exit(1);
  }

  const { program, connection, programId } = getProgram(config, keypair);
  const escrowPda = new PublicKey(contract.escrow_pda);
  const escrowState = await getEscrowState(connection, programId, escrowPda);
  if (!escrowState) {
    console.error("Escrow not found on-chain.");
    console.error(
      "If you restarted localnet, re-run `nebulon contract <id> init`."
    );
    process.exit(1);
  }
  const escrowId = escrowState.escrowId;

  let deadline = contract.deadline;
  let totalPayment = contract.total_payment;
  let promptLabel = "";

  if (field === "deadline") {
    if (wallet !== contract.client_wallet) {
      console.error("Only the customer can set the deadline.");
      process.exit(1);
    }
    const parsed = parseDeadlineInput(value);
    deadline = parsed.deadline.toString();
    promptLabel = parsed.label;
  } else if (field === "payment") {
    const parsed = parseAmountInput(value);
    totalPayment = parsed.base.toString();
    promptLabel = parsed.display;
  } else {
    console.error("Unknown term field.");
    process.exit(1);
  }

  console.log("Verify data and confirm actions please.");
  renderContractSummary(contract, wallet);
  console.log("-Action-");
  console.log(`Add term ${field}`);
  console.log(`Value : ${promptLabel}`);
  console.log("");

  const canProceed = await renderBalancesOrAbort(
    config,
    walletKey,
    contract.mint || config.usdcMint
  );
  if (!canProceed) {
    return;
  }

  const proceed = await confirmAction(options.confirm, "Proceed? yes/no");
  if (!proceed) {
    console.log("Canceled.");
    return;
  }

  const executionMode = await ensureExecutionMode(config, contract, keypair, options);
  const l1Mode = executionMode === "l1";

  let encryptedTerms = null;
  if (!l1Mode) {
    try {
      const privacyKey = await getContractPrivacyKey(config, contract.id, wallet);
      encryptedTerms = encryptTermsPayload(
        privacyKey,
        contract.id,
        deadline,
        totalPayment
      );
    } catch (error) {
      console.error(
        "Privacy key exchange pending. Wait for the counterparty to accept."
      );
      process.exit(1);
    }
  }

  await updateContractIfNegotiating(config, contract, {
    ...(l1Mode ? {} : { termsEncrypted: encryptedTerms }),
    termsHash: buildTermsHashHex(deadline, totalPayment),
    ...(l1Mode ? { deadline, totalPayment } : {}),
  });

  if (!deadline || !totalPayment) {
    console.log("Saved term. Set the remaining term to submit on-chain.");
    successMessage("Term saved.");
    return;
  }
  if (wallet !== contract.client_wallet) {
    console.log(
      "Saved term. Ask the customer to submit the terms on-chain to continue."
    );
    successMessage("Term saved.");
    return;
  }

  console.log("Processing.");
  try {
    const sig = l1Mode
      ? await submitPublicTerms(
          config,
          contract,
          keypair,
          escrowPda,
          escrowId,
          totalPayment,
          deadline
        )
      : await submitTerms(
          config,
          contract,
          keypair,
          escrowPda,
          escrowId,
          totalPayment,
          deadline,
          encryptedTerms
        );
    if (!sig) {
      return;
    }
    console.log(`Terms submitted. (tx: ${sig})`);
    successMessage("Terms submitted.");
  } catch (error) {
    await printTxLogs(error);
    throw error;
  }
};

const runSignContract = async (config, contract, options) => {
  const { keypair, wallet, walletKey } = getWalletContext(config);
  if (!contract.escrow_pda) {
    console.error("Contract has no escrow. Unable to sign.");
    process.exit(1);
  }
  const executionMode = await ensureExecutionMode(config, contract, keypair, options);
  const l1Mode = executionMode === "l1";
  ensureContractPhase(
    contract,
    ["negotiating", "awaiting_signatures"],
    "Finish terms/milestones, then sign."
  );
  if (!l1Mode && contract.terms_encrypted && !contract.privacyReady) {
    console.error("Privacy key exchange pending. Unable to read terms.");
    process.exit(1);
  }
  const missing = [];
  const milestones = Array.isArray(contract.milestones)
    ? contract.milestones
    : [];
  if (!milestones.length) {
    missing.push("It needs at least 1 Milestone");
  }
  if (!contract.deadline) {
    missing.push("Missing Term : Deadline");
  }
  if (!contract.total_payment) {
    missing.push("Missing Term : Payment");
  }
  if (missing.length) {
    console.error("Cant sign contract until the following is resolved.");
    missing.forEach((item) => console.error(`-${item}`));
    process.exit(1);
  }

  const { program, connection, programId } = getProgram(config, keypair);
  const escrowPda = new PublicKey(contract.escrow_pda);
  const escrowState = await getEscrowState(connection, programId, escrowPda);
  if (!escrowState) {
    console.error("Escrow not found on-chain.");
    process.exit(1);
  }
  const escrowId = escrowState.escrowId;

  console.log("Verify data and confirm actions please.");
  renderContractSummary(contract, wallet);
  console.log("-Action-");
  console.log("Sign Contract");
  console.log("");
  console.log("-Milestone List-");
  renderMilestones(contract.milestones || []);
  console.log("");
  console.log("-Terms-");
  console.log(`Deadline : ${formatDeadlineValue(contract.deadline)}`);
  console.log(`Payment : ${formatUsdc(contract.total_payment)} USDC`);
  console.log("");
  console.log(
    "By signing this contract you agree to the milestones and terms of it, and commit to be transparent and active with the progress of it."
  );
  console.log("");

  const canProceed = await renderBalancesOrAbort(
    config,
    walletKey,
    contract.mint || config.usdcMint
  );
  if (!canProceed) {
    return;
  }

  const proceed = await confirmAction(options.confirm, "Sign contract? yes/no");
  if (!proceed) {
    console.log("Canceled.");
    return;
  }

  console.log("Processing.");
  let signSig = null;
  let commitSig = null;
  if (l1Mode) {
    signSig = (await signPublicTermsOnChain(
      config,
      keypair,
      escrowPda,
      escrowId
    )).sig;
    console.log(`Signature submitted. (tx: ${signSig})`);
    try {
      commitSig = await commitPublicTermsOnChain(
        config,
        keypair,
        escrowPda,
        escrowId
      );
    } catch (error) {
      commitSig = null;
    }
  } else {
    const { termsPda } = await ensureTermsPrepared(
      config,
      contract,
      keypair,
      escrowPda,
      escrowId
    );
    const { program: erProgram, sessionSigner, sessionPda } =
      await getPerProgramBundle(
        config,
        keypair,
        programId,
        program.provider
      );
    signSig = await erProgram.methods
      .signPrivateTerms(new anchor.BN(escrowId.toString()))
      .accounts({
        user: keypair.publicKey,
        payer: sessionSigner.publicKey,
        sessionToken: sessionPda,
        escrow: escrowPda,
        terms: termsPda,
      })
      .signers([sessionSigner])
      .rpc({ skipPreflight: true });
    console.log(`Signature submitted. (tx: ${signSig})`);
    try {
      commitSig = await erProgram.methods
        .commitTerms(new anchor.BN(escrowId.toString()))
        .accounts({
          user: keypair.publicKey,
          payer: sessionSigner.publicKey,
          sessionToken: sessionPda,
          escrow: escrowPda,
          terms: termsPda,
        })
        .signers([sessionSigner])
        .rpc({ skipPreflight: true });
    } catch (error) {
      commitSig = null;
    }
  }
  if (commitSig) {
    console.log(`Terms committed. (tx: ${commitSig})`);
    console.log("Syncing contract flags...");
    let synced = false;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        await runSyncFlags(config, contract, { confirm: true });
        synced = true;
        break;
      } catch (error) {
        console.log("DEBUG: Sync error:", error);
        const errorString = JSON.stringify(error);
        console.log("DEBUG: Error string:", errorString);
        const message = (error && error.message ? error.message : errorString).toLowerCase();
        if (message.includes("cannot be written") || message.includes("writable account") || message.includes("invalidwritableaccount")) {
          if (attempt === 0) {
            await sleep(3000);
            continue;
          }
          console.log("Sync failed. Run `nebulon contract <id> sync` and retry after a few seconds.");
          return;
        }
        throw error;
      }
    }
  } else {
    console.log("Waiting for the other party to sign.");
  }

  if (contract.status === "negotiating") {
    await lockContract(config.backendUrl, config.auth.token, contract.id);
  }
  try {
    await signContract(config.backendUrl, config.auth.token, contract.id);
  } catch (error) {
    if (error && error.message === "already_signed") {
      console.log("You have already signed this contract.");
      return;
    }
    if (error && error.message === "invalid_status") {
      try {
        const refreshed = await refreshContract(
          config.backendUrl,
          config.auth.token,
          contract.id
        );
        if (refreshed && refreshed.contract && refreshed.contract.status) {
          console.log(
            `Contract phase updated to ${refreshed.contract.status}.`
          );
        } else {
          console.log("Contract phase does not allow signing right now.");
        }
      } catch (refreshError) {
        console.log("Contract phase does not allow signing right now.");
      }
      return;
    }
    throw error;
  }
  successMessage("Contract signed.");
};

const runFundContract = async (config, contract, options) => {
  const { keypair, wallet, walletKey } = getWalletContext(config);
  if (!contract.escrow_pda) {
    console.error("Contract has no escrow. Unable to fund.");
    process.exit(1);
  }
  ensureContractPhase(contract, ["waiting_for_funding"], "Run sign first.");
  if (!isL1Mode(contract) && contract.terms_encrypted && !contract.privacyReady) {
    console.error("Privacy key exchange pending. Unable to read terms.");
    process.exit(1);
  }
  const role = getRole(contract, wallet);
  if (role !== "client") {
    console.error("Only the customer can fund this contract.");
    process.exit(1);
  }
  await ensureExecutionMode(config, contract, keypair, options);
  if (!contract.total_payment) {
    console.error("Contract payment is missing.");
    process.exit(1);
  }

  const { program, connection, programId } = getProgram(config, keypair);
  const escrowPda = new PublicKey(contract.escrow_pda);
  const escrowState = await getEscrowState(connection, programId, escrowPda);
  if (!escrowState) {
    console.error("Escrow not found on-chain.");
    process.exit(1);
  }
  if (escrowState._ownerIsDelegated) {
    console.error("Escrow is delegated. Run `nebulon contract <id> sync` to undelegate before funding.");
    process.exit(1);
  }
  const hasTerms = escrowState.termsHash
    ? escrowState.termsHash.some((byte) => byte !== 0)
    : false;
  if (!hasTerms) {
    console.error("Terms are not committed on-chain yet.");
    process.exit(1);
  }
  const hasMilestones = Array.isArray(contract.milestones)
    ? contract.milestones.length > 0
    : false;
  const hasMilestonesHash = escrowState.milestonesHash
    ? escrowState.milestonesHash.some((byte) => byte !== 0)
    : false;
  if (hasMilestones && !hasMilestonesHash) {
    console.error("Milestones are not committed on-chain yet.");
    console.error("Run `nebulon contract <id> sync` before funding.");
    process.exit(1);
  }
  const escrowId = escrowState.escrowId;
  const amount = BigInt(contract.total_payment);

  console.log("Verify data and confirm actions please.");
  renderContractSummary(contract, wallet);
  console.log("-Action-");
  console.log("Fund Contract");
  console.log(`Amount : ${formatUsdc(amount)} USDC`);
  const feeEstimate = feeFromGross(amount);
  const netEstimate = netFromGross(amount);
  const coverAmount = grossFromNet(amount);
  console.log(
    `  Protocol fee (2%): ${formatUsdc(feeEstimate)} USDC (contractor receives ${formatUsdc(netEstimate)}).`
  );
  console.log(
    `  To cover the fee so the contractor receives your desired amount, set payment to ~${formatUsdc(coverAmount)} USDC.`
  );
  console.log("");

  const balances = await renderBalances(
    config,
    walletKey,
    contract.mint || config.usdcMint
  );
  if (!ensureSolBalance(balances)) {
    return;
  }
  if (balances) {
    const requiredUsdc = Number(formatUsdc(contract.total_payment));
    if (Number.isFinite(requiredUsdc) && balances.usdc < requiredUsdc) {
      console.error(
        `Insufficient USDC balance. Need ${formatUsdc(contract.total_payment)} USDC, have ${balances.usdc.toFixed(6)} USDC.`
      );
      return;
    }
  }

  const proceed = await confirmAction(
    options.confirm,
    `Do you want to fund this contract with ${formatUsdc(amount)} USDC? yes/no`
  );
  if (!proceed) {
    console.log("Canceled.");
    return;
  }

  console.log("Processing.");
  const mint = new PublicKey(contract.mint || config.usdcMint);
  const clientToken = await ensureAta(connection, keypair, walletKey, mint);
  const feeReceiverToken = await ensureAta(
    connection,
    keypair,
    FEE_RECEIVER,
    mint
  );
  const vaultToken = await getAssociatedTokenAddress(mint, escrowPda, true);

  const sig = await program.methods
    .fundEscrow(
      new anchor.BN(escrowId.toString()),
      new anchor.BN(amount.toString())
    )
    .accounts({
      client: walletKey,
      escrow: escrowPda,
      clientToken,
      feeReceiverToken,
      vaultToken,
      tokenProgram: TOKEN_PROGRAM_ID,
    })
    .signers([keypair])
    .rpc();
  console.log(`Funding submitted. (tx: ${sig})`);

  await markFunded(config.backendUrl, config.auth.token, contract.id);
  console.log("Syncing private state to escrow flags.");
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      await runSyncFlags(config, contract, { ...options, confirm: true });
      break;
    } catch (error) {
      const message = (error && error.message ? error.message : JSON.stringify(error)).toLowerCase();
      if (message.includes("cannot be written") || message.includes("writable account") || message.includes("invalidwritableaccount")) {
        if (attempt < 2) {
          console.log(`Sync attempt ${attempt + 1} failed. Retrying in 5 seconds...`);
          await sleep(5000);
          continue;
        }
        console.log("Sync failed. Run `nebulon contract <id> sync` and retry after a few seconds.");
        return;
      }
      throw error;
    }
  }
  successMessage("Contract funded.");
};

const runUpdateMilestone = async (config, contract, number, options) => {
  const { keypair, wallet, walletKey } = getWalletContext(config);
  if (!contract.escrow_pda) {
    console.error("Contract has no escrow.");
    process.exit(1);
  }
  ensureContractPhase(
    contract,
    ["waiting_for_milestones_report", "in_progress"],
    "Fund the contract first."
  );
  const role = getRole(contract, wallet);
  if (role !== "contractor") {
    console.error("Only the service provider can submit milestones.");
    process.exit(1);
  }
  const index = Number(number) - 1;
  if (!Number.isFinite(index) || index < 0) {
    console.error("Invalid milestone number.");
    process.exit(1);
  }
  const milestoneList = Array.isArray(contract.milestones)
    ? contract.milestones
    : [];
  const milestoneMeta = milestoneList.find((milestone) => milestone.index === index);
  if (!milestoneMeta) {
    console.error("Milestone not found.");
    console.error("Check the list with: nebulon contract <id> check milestone list");
    return;
  }
  const executionMode = await ensureExecutionMode(config, contract, keypair, options);
  const l1Mode = executionMode === "l1";
  if (l1Mode) {
    const { program, connection, programId } = getProgram(config, keypair);
    const escrowPda = new PublicKey(contract.escrow_pda);
    const escrowState = await getEscrowState(connection, programId, escrowPda);
    if (!escrowState) {
      console.error("Escrow not found on-chain.");
      process.exit(1);
    }
    const ok = await ensureEscrowOwnedByProgramL1(config, keypair, escrowPda);
    if (!ok) {
      return;
    }
    const escrowId = escrowState.escrowId;
    const milestonePda = deriveMilestonePda(escrowPda, index, programId);

    console.log("Verify data and confirm actions please.");
    renderContractSummary(contract, wallet);
    console.log("-Action-");
    console.log("Update milestone");
    console.log(`Number : ${index + 1}`);
    console.log("Status : ready");
    console.log("");

    const canProceed = await renderBalancesOrAbort(
      config,
      walletKey,
      contract.mint || config.usdcMint
    );
    if (!canProceed) {
      return;
    }

    const proceed = await confirmAction(options.confirm, "Proceed? yes/no");
    if (!proceed) {
      console.log("Canceled.");
      return;
    }

    console.log("Processing.");
    const sig = await program.methods
      .submitMilestone(new anchor.BN(escrowId.toString()), index)
      .accounts({
        contractor: walletKey,
        escrow: escrowPda,
        milestone: milestonePda,
      })
      .signers([keypair])
      .rpc();
    console.log(`Milestone updated. (tx: ${sig})`);

    const milestones = Array.isArray(contract.milestones)
      ? contract.milestones.map((milestone) =>
          milestone.index === index
            ? { ...milestone, status: "ready" }
            : milestone
        )
      : [];
    const persisted = await updateContractMilestones(config, contract, milestones);
    if (!persisted) {
      console.log(
        "Warning: backend did not persist milestone status (check backend version)."
      );
    }
    await runSyncFlags(config, contract, { ...options, confirm: true });
    successMessage("Milestone updated.");
    return;
  }
  if (!config.ephemeralProviderUrl) {
    console.error(
      "Warning: MagicBlock RPC is not configured; milestone status checks may be unreliable."
    );
    console.error("Run `nebulon init` to fetch the MagicBlock endpoints.");
  }
  if (milestoneMeta.status === "approved") {
    console.error("Milestone already confirmed.");
    console.error("Current status: paid");
    return;
  }
  if (milestoneMeta.status === "disabled") {
    console.error("Milestone is disabled.");
    console.error("Current status: disabled");
    return;
  }
  let currentStatus = null;
  try {
    const milestone = await getPrivateMilestoneStatus(
      config,
      contract,
      keypair,
      walletKey,
      index
    );
    currentStatus = milestone ? milestone.status : null;
  } catch (error) {
    console.error("Unable to verify milestone status.");
    process.exit(1);
  }
  const statusValue = Number(currentStatus);
  if (!Number.isFinite(statusValue)) {
    console.error("Unable to determine milestone status.");
    return;
  }
  const statusLabel = formatPrivateMilestoneStatus(statusValue);
  if (statusValue === 1) {
    console.error("Milestone already submitted and awaiting customer confirmation.");
    console.error("Current status: submitted");
    return;
  }
  if (statusValue === 3) {
    console.error("Milestone already confirmed.");
    console.error("Current status: paid");
    return;
  }
  if (statusValue === 4) {
    console.error("Milestone is disabled.");
    console.error("Current status: disabled");
    return;
  }
  if (statusValue !== 0 && statusValue !== 2) {
    console.error(`Cannot mark milestone as ready from status: ${statusLabel}`);
    return;
  }

  console.log("Verify data and confirm actions please.");
  renderContractSummary(contract, wallet);
  console.log("-Action-");
  console.log("Update milestone");
  console.log(`Number : ${index + 1}`);
  console.log("Status : ready");
  console.log("");

  const canProceed = await renderBalancesOrAbort(
    config,
    walletKey,
    contract.mint || config.usdcMint
  );
  if (!canProceed) {
    return;
  }

  const proceed = await confirmAction(options.confirm, "Proceed? yes/no");
  if (!proceed) {
    console.log("Canceled.");
    return;
  }

  console.log("Processing.");
  const sig = await updatePrivateMilestoneStatus(
    config,
    contract,
    keypair,
    walletKey,
    index,
    1
  );
  console.log(`Milestone updated. (tx: ${sig})`);

  const milestones = Array.isArray(contract.milestones)
    ? contract.milestones.map((milestone) =>
        milestone.index === index
          ? { ...milestone, status: "ready" }
          : milestone
      )
    : [];
  const persisted = await updateContractMilestones(config, contract, milestones);
  if (!persisted) {
    console.log(
      "Warning: backend did not persist milestone status (check backend version)."
    );
  }
  await runSyncFlags(config, contract, { ...options, confirm: true });
  successMessage("Milestone updated.");
};

const runConfirmMilestone = async (config, contract, number, options) => {
  const { keypair, wallet, walletKey } = getWalletContext(config);
  if (!contract.escrow_pda) {
    console.error("Contract has no escrow.");
    process.exit(1);
  }
  ensureContractPhase(
    contract,
    ["in_progress"],
    "Waiting on contractor submissions."
  );
  const role = getRole(contract, wallet);
  if (role !== "client") {
    console.error("Only the customer can confirm milestones.");
    process.exit(1);
  }
  const index = Number(number) - 1;
  if (!Number.isFinite(index) || index < 0) {
    console.error("Invalid milestone number.");
    process.exit(1);
  }

  const executionMode = await ensureExecutionMode(config, contract, keypair, options);
  const l1Mode = executionMode === "l1";
  if (l1Mode) {
    const { program, connection, programId } = getProgram(config, keypair);
    const escrowPda = new PublicKey(contract.escrow_pda);
    const escrowState = await getEscrowState(connection, programId, escrowPda);
    if (!escrowState) {
      console.error("Escrow not found on-chain.");
      process.exit(1);
    }
    const ok = await ensureEscrowOwnedByProgramL1(config, keypair, escrowPda);
    if (!ok) {
      return;
    }
    const escrowId = escrowState.escrowId;
    const milestonePda = deriveMilestonePda(escrowPda, index, programId);

    console.log("Verify data and confirm actions please.");
    renderContractSummary(contract, wallet);
    console.log("-Action-");
    console.log("Confirm milestone");
    console.log(`Number : ${index + 1}`);
    console.log("");

    const canProceed = await renderBalancesOrAbort(
      config,
      walletKey,
      contract.mint || config.usdcMint
    );
    if (!canProceed) {
      return;
    }

    const proceed = await confirmAction(options.confirm, "Proceed? yes/no");
    if (!proceed) {
      console.log("Canceled.");
      return;
    }

    console.log("Processing.");
    const sig = await program.methods
      .approveMilestone(new anchor.BN(escrowId.toString()), index)
      .accounts({
        client: walletKey,
        escrow: escrowPda,
        milestone: milestonePda,
      })
      .signers([keypair])
      .rpc();
    console.log(`Milestone confirmed. (tx: ${sig})`);

    const milestones = Array.isArray(contract.milestones)
      ? contract.milestones.map((milestone) =>
          milestone.index === index
            ? { ...milestone, status: "approved" }
            : milestone
        )
      : [];
    const persisted = await updateContractMilestones(config, contract, milestones);
    if (!persisted) {
      console.log(
        "Warning: backend did not persist milestone status (check backend version)."
      );
    }
    await runSyncFlags(config, contract, { ...options, confirm: true });
    try {
      const refreshed = await getEscrowState(connection, programId, escrowPda);
      if (refreshed && refreshed.readyToClaim) {
        successMessage("Contract funds are now ready to claim by the service provider.");
      }
    } catch {}
    successMessage("Milestone confirmed.");
    return;
  }

  console.log("Verify data and confirm actions please.");
  renderContractSummary(contract, wallet);
  console.log("-Action-");
  console.log("Confirm milestone");
  console.log(`Number : ${index + 1}`);
  console.log("");

  let currentStatus = null;
  try {
    const milestone = await getPrivateMilestoneStatus(
      config,
      contract,
      keypair,
      walletKey,
      index
    );
    currentStatus = milestone ? milestone.status : null;
  } catch (error) {
    console.error("Unable to verify milestone status.");
    process.exit(1);
  }
  const statusValue = Number(currentStatus);
  if (!Number.isFinite(statusValue)) {
    console.error("Unable to determine milestone status.");
    return;
  }
  const statusLabel = formatPrivateMilestoneStatus(statusValue);
  if (statusValue !== 1) {
    console.error(`Milestone is not ready to confirm. Current status: ${statusLabel}`);
    return;
  }

  const canProceed = await renderBalancesOrAbort(
    config,
    walletKey,
    contract.mint || config.usdcMint
  );
  if (!canProceed) {
    return;
  }

  const proceed = await confirmAction(options.confirm, "Proceed? yes/no");
  if (!proceed) {
    console.log("Canceled.");
    return;
  }

  console.log("Processing.");
  const sig = await updatePrivateMilestoneStatus(
    config,
    contract,
    keypair,
    walletKey,
    index,
    3
  );
  console.log(`Milestone confirmed. (tx: ${sig})`);

  const milestones = Array.isArray(contract.milestones)
    ? contract.milestones.map((milestone) =>
        milestone.index === index
          ? { ...milestone, status: "approved" }
          : milestone
      )
    : [];
  const persisted = await updateContractMilestones(config, contract, milestones);
  if (!persisted) {
    console.log(
      "Warning: backend did not persist milestone status (check backend version)."
    );
  }
  await runSyncFlags(config, contract, { ...options, confirm: true });
  try {
    const refreshed = await getEscrowState(connection, programId, escrowPda);
    if (refreshed && refreshed.readyToClaim) {
      successMessage("Contract funds are now ready to claim by the service provider.");
    }
  } catch {}
  successMessage("Milestone confirmed.");
};

const runClaimFunds = async (config, contract, options) => {
  const { keypair, wallet, walletKey } = getWalletContext(config);
  if (!contract.escrow_pda) {
    console.error("Contract has no escrow.");
    process.exit(1);
  }

  const { program, connection, programId } = getProgram(config, keypair);
  const escrowPda = new PublicKey(contract.escrow_pda);
  const escrowState = await getEscrowState(connection, programId, escrowPda);
  if (!escrowState) {
    console.error("Escrow not found on-chain.");
    process.exit(1);
  }
  if (escrowState.paidOut) {
    console.log("Funds already claimed. Contract completed successfully.");
    return;
  }
  const escrowId = escrowState.escrowId;
  const readyToClaim = Boolean(escrowState.readyToClaim);
  const timeoutFundsReady = Boolean(escrowState.timeoutFundsReady);
  const timeoutRefundReady = Boolean(escrowState.timeoutRefundReady);

  const mint = new PublicKey(contract.mint || config.usdcMint);
  const vaultToken = await getAssociatedTokenAddress(mint, escrowPda, true);

  if (wallet === contract.contractor_wallet) {
    if (!readyToClaim && !timeoutFundsReady) {
      console.error("Contract is not ready to claim yet.");
      return;
    }
    const rawFunded =
      typeof escrowState.fundedAmount === "bigint"
        ? escrowState.fundedAmount
        : BigInt(escrowState.fundedAmount || 0);
    console.log("Verify data and confirm actions please.");
    renderContractSummary(contract, wallet);
    console.log("-Action-");
    console.log("Claim funds");
    console.log(`Amount : ${formatUsdc(rawFunded)} USDC`);
    console.log("");

      const canProceed = await renderBalancesOrAbort(
        config,
        walletKey,
        contract.mint || config.usdcMint
      );
      if (!canProceed) {
        return;
      }

    const proceed = await confirmAction(options.confirm, "Proceed? yes/no");
    if (!proceed) {
      console.log("Canceled.");
      return;
    }

    const contractorToken = await ensureAta(connection, keypair, walletKey, mint);
    if (readyToClaim) {
      try {
        const sig = await program.methods
          .claimFunds(new anchor.BN(escrowId.toString()))
          .accounts({
            contractor: walletKey,
            creator: escrowState.creator,
            escrow: escrowPda,
            contractorToken,
            vaultToken,
            tokenProgram: TOKEN_PROGRAM_ID,
          })
          .signers([keypair])
          .rpc();
        console.log(`Funds claimed. (tx: ${sig})`);
        successMessage(
          `Funds claimed successfully. (+${formatUsdc(rawFunded)} USDC)`
        );
        successMessage("Escrow rent returned to the creator.");
        try {
          await refreshContract(config.backendUrl, config.auth.token, contract.id);
        } catch {
          console.log("Warning: backend status refresh failed.");
        }
        return;
      } catch (error) {
        errorMessage("Escrow rent was not returned.");
        throw error;
      }
    }
    if (timeoutFundsReady) {
      try {
        const sig = await program.methods
          .claimTimeoutFunds(new anchor.BN(escrowId.toString()))
          .accounts({
            contractor: walletKey,
            creator: escrowState.creator,
            escrow: escrowPda,
            contractorToken,
            vaultToken,
            tokenProgram: TOKEN_PROGRAM_ID,
          })
          .signers([keypair])
          .rpc();
        console.log(`Timeout funds claimed. (tx: ${sig})`);
        successMessage(
          `Funds claimed successfully. (+${formatUsdc(rawFunded)} USDC)`
        );
        successMessage("Escrow rent returned to the creator.");
        try {
          await refreshContract(config.backendUrl, config.auth.token, contract.id);
        } catch {
          console.log("Warning: backend status refresh failed.");
        }
        return;
      } catch (error) {
        errorMessage("Escrow rent was not returned.");
        throw error;
      }
    }
    return;
  }

  if (wallet === contract.client_wallet) {
    if (!timeoutRefundReady) {
      console.error("Refund is not available for this contract.");
      return;
    }
    console.log("Verify data and confirm actions please.");
    renderContractSummary(contract, wallet);
    console.log("-Action-");
    console.log("Claim funds");
    console.log("");

    const canProceed = await renderBalancesOrAbort(
      config,
      walletKey,
      contract.mint || config.usdcMint
    );
    if (!canProceed) {
      return;
    }

    const proceed = await confirmAction(options.confirm, "Proceed? yes/no");
    if (!proceed) {
      console.log("Canceled.");
      return;
    }

    const clientToken = await ensureAta(connection, keypair, walletKey, mint);
    try {
      const sig = await program.methods
        .claimTimeoutRefund(new anchor.BN(escrowId.toString()))
        .accounts({
          client: walletKey,
          creator: escrowState.creator,
          escrow: escrowPda,
          clientToken,
          vaultToken,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([keypair])
        .rpc();
      console.log(`Refund claimed. (tx: ${sig})`);
      successMessage("Refund claimed.");
      successMessage("Escrow rent returned to the creator.");
      try {
        await refreshContract(config.backendUrl, config.auth.token, contract.id);
      } catch {
        console.log("Warning: backend status refresh failed.");
      }
      return;
    } catch (error) {
      errorMessage("Escrow rent was not returned.");
      throw error;
    }
  }

  console.error("Only contract participants can claim funds.");
};


const fetchPrivateMilestones = async (
  erProgram,
  escrowPda,
  programId,
  indices
) => {
  const milestones = [];
  for (const index of indices) {
    const pda = derivePrivateMilestonePda(escrowPda, index, programId);
    const state = await erProgram.account.privateMilestone.fetch(pda);
    milestones.push({
      index,
      status: Number(state.status),
      descriptionHash: state.descriptionHash || state.description_hash,
      pda,
    });
  }
  return milestones;
};

const updatePrivateMilestoneStatus = async (
  config,
  contract,
  keypair,
  walletKey,
  index,
  status
) => {
  const { program, connection, programId } = getProgram(config, keypair);
  const escrowPda = new PublicKey(contract.escrow_pda);
  const escrowState = await getEscrowState(connection, programId, escrowPda);
  if (!escrowState) {
    console.error("Escrow not found on-chain.");
    process.exit(1);
  }

  const escrowId = escrowState.escrowId;
  const privateMilestonePda = derivePrivateMilestonePda(
    escrowPda,
    index,
    programId
  );

  const members = buildMembers(contract);
  members.accountType = {
    privateMilestone: {
      escrow: escrowPda,
      index,
    },
  };
  await ensurePermission(config, program, keypair, privateMilestonePda, members);
  await ensureDelegatedPermission(
    config,
    program.provider,
    keypair,
    privateMilestonePda
  );
  await ensureDelegatedAccount(
    config,
    program,
    keypair,
    members.accountType,
    privateMilestonePda
  );
  await ensureDelegatedEscrow(
    config,
    program,
    keypair,
    escrowId,
    escrowPda,
    new PublicKey(contract.client_wallet)
  );

  const { program: erProgram, sessionSigner, sessionPda } =
    await getPerProgramBundle(config, keypair, programId, program.provider);

  const sig = await erProgram.methods
    .updatePrivateMilestoneStatus(
      new anchor.BN(escrowId.toString()),
      index,
      status
    )
    .accounts({
      user: walletKey,
      payer: sessionSigner.publicKey,
      sessionToken: sessionPda,
      escrow: escrowPda,
      privateMilestone: privateMilestonePda,
    })
    .signers([sessionSigner])
    .rpc({ skipPreflight: true });

  return sig;
};

const runSyncFlagsL1 = async (config, contract, options) => {
  const { keypair, walletKey } = getWalletContext(config);
  if (!contract.escrow_pda) {
    console.error("Contract has no escrow.");
    process.exit(1);
  }

  const { program, connection, programId } = getProgram(config, keypair);
  const escrowPda = new PublicKey(contract.escrow_pda);
  const escrowState = await getEscrowState(connection, programId, escrowPda);
  if (!escrowState) {
    console.error("Escrow not found on-chain.");
    process.exit(1);
  }
  const ok = await ensureEscrowOwnedByProgramL1(config, keypair, escrowPda);
  if (!ok) {
    return;
  }

  const escrowId = escrowState.escrowId;
  const termsPda = deriveTermsPda(escrowPda, programId);

  let terms;
  try {
    terms = await program.account.terms.fetch(termsPda);
  } catch (error) {
    console.error("Terms not available on-chain yet.");
    process.exit(1);
  }

  const milestoneIndices = Array.isArray(contract.milestones)
    ? contract.milestones.map((milestone) => milestone.index)
    : [];
  milestoneIndices.sort((a, b) => a - b);
  const milestones = await fetchPublicMilestones(
    program,
    escrowPda,
    programId,
    milestoneIndices
  );
  const milestonesHash = buildMilestonesHash(milestones);

  const fundedAmount =
    typeof escrowState.fundedAmount === "bigint"
      ? escrowState.fundedAmount
      : BigInt(escrowState.fundedAmount || 0);
  const canCommitMilestones = fundedAmount === 0n && !escrowState.fundingOk;
  const totalPayment = BigInt(terms.totalPayment.toString());
  const requiredNet = netFromGross(totalPayment);
  const fundingOk = fundedAmount >= requiredNet;
  const hasTermsHash = escrowState.termsHash
    ? escrowState.termsHash.some((byte) => byte !== 0)
    : false;
  if (!hasTermsHash) {
    console.log("Terms hash not committed on-chain yet.");
  }

  const deadline = resolveTermsDeadline(
    Number(terms.deadline.toString()),
    escrowState.fundedAt
  );
  const now = Math.floor(Date.now() / 1000);
  const deadlinePassed = deadline ? now > deadline : false;

  const statuses = milestones.map((milestone) =>
    Number.isFinite(milestone.status) ? milestone.status : 0
  );
  const allApproved =
    milestones.length === 0 ||
    statuses.every((status) => status === 3 || status === 4);
  const allSubmitted =
    milestones.length === 0 ||
    statuses.every((status) => status === 1 || status === 3 || status === 4);
  const hasUnsubmitted =
    milestones.length === 0 ||
    statuses.some((status) => status === 0 || status === 2);

  const milestoneCount = milestones.length;
  if (milestoneCount > 255) {
    console.error("Too many milestones to sync.");
    process.exit(1);
  }

  const proceed = await confirmAction(options.confirm, "Update escrow flags? yes/no");
  if (!proceed) {
    console.log("Canceled.");
    return;
  }

  let didUpdate = false;
  const milestoneAccounts = milestones.map((milestone) => ({
    pubkey: milestone.pda,
    isWritable: false,
    isSigner: false,
  }));

  if (canCommitMilestones && milestonesHash && escrowState.milestonesHash) {
    const currentHash = Buffer.from(escrowState.milestonesHash);
    if (!currentHash.equals(milestonesHash)) {
      const sig = await program.methods
        .commitPublicMilestones(
          new anchor.BN(escrowId.toString()),
          Array.from(milestonesHash)
        )
        .accounts({
          user: walletKey,
          escrow: escrowPda,
        })
        .signers([keypair])
        .rpc();
      console.log(`Milestones committed. (tx: ${sig})`);
      didUpdate = true;
    }
  }

  if (hasTermsHash && fundingOk && !escrowState.fundingOk) {
    const sig = await program.methods
      .setFundingOkPublic(new anchor.BN(escrowId.toString()))
      .accounts({
        user: walletKey,
        escrow: escrowPda,
        terms: termsPda,
      })
      .signers([keypair])
      .rpc();
    console.log(`Funding verified. (tx: ${sig})`);
    didUpdate = true;
  }

  let readyToClaimSet = false;
  if (hasTermsHash && fundingOk && allApproved && !escrowState.readyToClaim) {
    const sig = await program.methods
      .setReadyToClaimPublic(new anchor.BN(escrowId.toString()), milestoneCount)
      .accounts({
        user: walletKey,
        escrow: escrowPda,
      })
      .remainingAccounts(milestoneAccounts)
      .signers([keypair])
      .rpc();
    console.log(`Ready to claim set. (tx: ${sig})`);
    didUpdate = true;
    readyToClaimSet = true;
  }

  if (!readyToClaimSet && deadlinePassed && fundingOk && hasUnsubmitted && !escrowState.timeoutRefundReady) {
    const sig = await program.methods
      .setTimeoutRefundReadyPublic(
        new anchor.BN(escrowId.toString()),
        milestoneCount
      )
      .accounts({
        user: walletKey,
        escrow: escrowPda,
        terms: termsPda,
      })
      .remainingAccounts(milestoneAccounts)
      .signers([keypair])
      .rpc();
    console.log(`Timeout refund ready set. (tx: ${sig})`);
    didUpdate = true;
  }

  if (!readyToClaimSet && deadlinePassed && fundingOk && allSubmitted && !escrowState.timeoutFundsReady) {
    const sig = await program.methods
      .setTimeoutFundsReadyPublic(
        new anchor.BN(escrowId.toString()),
        milestoneCount
      )
      .accounts({
        user: walletKey,
        escrow: escrowPda,
        terms: termsPda,
      })
      .remainingAccounts(milestoneAccounts)
      .signers([keypair])
      .rpc();
    console.log(`Timeout funds ready set. (tx: ${sig})`);
    didUpdate = true;
  }

  if (didUpdate) {
    successMessage("Sync completed.");
    return;
  }
  console.log("No updates were required.");
};

const runSyncFlags = async (config, contract, options) => {
  const { keypair, walletKey } = getWalletContext(config);
  if (!contract.escrow_pda) {
    console.error("Contract has no escrow.");
    process.exit(1);
  }
  if (isL1Mode(contract)) {
    await runSyncFlagsL1(config, contract, options);
    return;
  }

  const { program, connection, programId } = getProgram(config, keypair);
  const escrowPda = new PublicKey(contract.escrow_pda);
  const escrowState = await getEscrowState(connection, programId, escrowPda);
  if (!escrowState) {
    console.error("Escrow not found on-chain.");
    process.exit(1);
  }

  const escrowId = escrowState.escrowId;
  const { termsPda, program: l1Program } = await ensureTermsPrepared(
    config,
    contract,
    keypair,
    escrowPda,
    escrowId
  );

  const milestoneIndices = Array.isArray(contract.milestones)
    ? contract.milestones.map((milestone) => milestone.index)
    : [];
  milestoneIndices.sort((a, b) => a - b);
  for (const index of milestoneIndices) {
    const privateMilestonePda = derivePrivateMilestonePda(
      escrowPda,
      index,
      programId
    );
    const members = buildMembers(contract);
    members.accountType = {
      privateMilestone: {
        escrow: escrowPda,
        index,
      },
    };
    await ensurePermission(config, l1Program, keypair, privateMilestonePda, members);
    await ensureDelegatedPermission(
      config,
      l1Program.provider,
      keypair,
      privateMilestonePda
    );
    await ensureDelegatedAccount(
      config,
      l1Program,
      keypair,
      members.accountType,
      privateMilestonePda
    );
  }

  await ensureDelegatedEscrow(
    config,
    l1Program,
    keypair,
    escrowId,
    escrowPda,
    new PublicKey(contract.client_wallet)
  );

  const { program: erProgram, sessionSigner, sessionPda } =
    await getPerProgramBundle(config, keypair, programId, l1Program.provider);

  let terms;
  try {
    terms = await erProgram.account.terms.fetch(termsPda);
  } catch (error) {
    console.error("Terms not available in PER yet.");
    process.exit(1);
  }

  const milestones = await fetchPrivateMilestones(
    erProgram,
    escrowPda,
    programId,
    milestoneIndices
  );
  const milestonesHash = buildMilestonesHash(milestones);

  const fundedAmount =
    typeof escrowState.fundedAmount === "bigint"
      ? escrowState.fundedAmount
      : BigInt(escrowState.fundedAmount || 0);
  const canCommitMilestones = fundedAmount === 0n && !escrowState.fundingOk;
  const totalPayment = BigInt(terms.totalPayment.toString());
  const requiredNet = netFromGross(totalPayment);
  const fundingOk = fundedAmount === requiredNet;
  const hasTermsHash = escrowState.termsHash
    ? escrowState.termsHash.some((byte) => byte !== 0)
    : false;
  if (!hasTermsHash) {
    console.log("Terms hash not committed on-chain yet.");
  }

  const deadline = resolveTermsDeadline(
    Number(terms.deadline.toString()),
    escrowState.fundedAt
  );
  const now = Math.floor(Date.now() / 1000);
  const deadlinePassed = deadline ? now > deadline : false;

  const statuses = milestones.map((milestone) => milestone.status);
  const allApproved =
    milestones.length === 0 ||
    statuses.every((status) => status === 3 || status === 4);
  const allSubmitted =
    milestones.length === 0 ||
    statuses.every((status) => status === 1 || status === 3 || status === 4);
  const hasUnsubmitted =
    milestones.length === 0 ||
    statuses.some((status) => status === 0 || status === 2);

  const milestoneCount = milestones.length;
  if (milestoneCount > 255) {
    console.error("Too many milestones to sync.");
    process.exit(1);
  }

  const proceed = await confirmAction(options.confirm, "Update escrow flags? yes/no");
  if (!proceed) {
    console.log("Canceled.");
    return;
  }

  let didUpdate = false;
  const milestoneAccounts = milestones.map((milestone) => ({
    pubkey: milestone.pda,
    isWritable: false,
    isSigner: false,
  }));

  if (canCommitMilestones && milestonesHash && escrowState.milestonesHash) {
    const currentHash = Buffer.from(escrowState.milestonesHash);
    if (!currentHash.equals(milestonesHash)) {
      const sig = await erProgram.methods
        .commitMilestones(
          new anchor.BN(escrowId.toString()),
          Array.from(milestonesHash)
        )
        .accounts({
          user: keypair.publicKey,
          payer: sessionSigner.publicKey,
          sessionToken: sessionPda,
          escrow: escrowPda,
        })
        .signers([sessionSigner])
        .rpc({ skipPreflight: true });
      console.log(`Milestones committed. (tx: ${sig})`);
      didUpdate = true;
    }
  }

  if (hasTermsHash && fundingOk && !escrowState.fundingOk) {
    const sig = await erProgram.methods
      .setFundingOk(new anchor.BN(escrowId.toString()))
      .accounts({
        user: keypair.publicKey,
        payer: sessionSigner.publicKey,
        sessionToken: sessionPda,
        escrow: escrowPda,
        terms: termsPda,
      })
      .signers([sessionSigner])
      .rpc({ skipPreflight: true });
    console.log(`Funding verified. (tx: ${sig})`);
    didUpdate = true;
  }

  let readyToClaimSet = false;
  if (hasTermsHash && fundingOk && allApproved && !escrowState.readyToClaim) {
    const sig = await erProgram.methods
      .setReadyToClaim(
        new anchor.BN(escrowId.toString()),
        milestoneCount
      )
      .accounts({
        user: keypair.publicKey,
        payer: sessionSigner.publicKey,
        sessionToken: sessionPda,
        escrow: escrowPda,
      })
      .remainingAccounts(milestoneAccounts)
      .signers([sessionSigner])
      .rpc({ skipPreflight: true });
    console.log(`Ready to claim set. (tx: ${sig})`);
    didUpdate = true;
    readyToClaimSet = true;
  }

  if (
    hasTermsHash &&
    fundingOk &&
    deadlinePassed &&
    hasUnsubmitted &&
    !escrowState.timeoutRefundReady
  ) {
    const sig = await erProgram.methods
      .setTimeoutRefundReady(
        new anchor.BN(escrowId.toString()),
        milestoneCount
      )
      .accounts({
        user: keypair.publicKey,
        payer: sessionSigner.publicKey,
        sessionToken: sessionPda,
        escrow: escrowPda,
        terms: termsPda,
      })
      .remainingAccounts(milestoneAccounts)
      .signers([sessionSigner])
      .rpc({ skipPreflight: true });
    console.log(`Timeout refund ready set. (tx: ${sig})`);
    didUpdate = true;
  }

  if (
    hasTermsHash &&
    fundingOk &&
    deadlinePassed &&
    allSubmitted &&
    !escrowState.timeoutFundsReady
  ) {
    const sig = await erProgram.methods
      .setTimeoutFundsReady(
        new anchor.BN(escrowId.toString()),
        milestoneCount
      )
      .accounts({
        user: keypair.publicKey,
        payer: sessionSigner.publicKey,
        sessionToken: sessionPda,
        escrow: escrowPda,
        terms: termsPda,
      })
      .remainingAccounts(milestoneAccounts)
      .signers([sessionSigner])
      .rpc({ skipPreflight: true });
    console.log(`Timeout funds ready set. (tx: ${sig})`);
    didUpdate = true;
  }

  const shouldUndelegate = didUpdate || escrowState._ownerIsDelegated;
  if (shouldUndelegate) {
    const sig = await erProgram.methods
      .undelegateEscrow()
      .accounts({
        payer: sessionSigner.publicKey,
        escrow: escrowPda,
        magicProgram: MAGIC_PROGRAM_ID,
        magicContext: MAGIC_CONTEXT_ID,
      })
      .signers([sessionSigner])
      .rpc({ skipPreflight: true });
    console.log(`Escrow committed. (tx: ${sig})`);
  } else {
    console.log("No escrow flag changes needed.");
  }
  successMessage("Sync completed.");
  if (readyToClaimSet) {
    successMessage("Contract funds are now ready to claim by the service provider.");
  }
};

const runMilestoneList = async (config, contract) => {
  const { keypair, wallet, walletKey } = getWalletContext(config);
  if (!contract.escrow_pda) {
    console.error("Contract has no escrow.");
    process.exit(1);
  }
  const role = getRole(contract, wallet);
  if (role !== "client" && role !== "contractor") {
    console.error("Only contract participants can view milestone details.");
    process.exit(1);
  }

  renderContractSummary(contract, wallet);
  console.log("");
  const phaseLabel = ACTIVE_STATUSES.has(contract.status)
    ? "Milestones"
    : `Milestones [${contract.status} phase]`;
  console.log(phaseLabel);

  const { program, connection, programId } = getProgram(config, keypair);
  const escrowPda = new PublicKey(contract.escrow_pda);
  const escrowState = await getEscrowState(connection, programId, escrowPda);
  if (!escrowState) {
    console.error("Escrow not found on-chain.");
    process.exit(1);
  }

  const milestoneIndices = Array.isArray(contract.milestones)
    ? contract.milestones.map((milestone) => milestone.index)
    : [];
  if (!milestoneIndices.length) {
    console.log("(No milestones)");
    return;
  }
  milestoneIndices.sort((a, b) => a - b);

  let milestones = [];
  if (isL1Mode(contract)) {
    milestones = await fetchPublicMilestones(
      program,
      escrowPda,
      programId,
      milestoneIndices
    );
  } else {
    const { program: erProgram } = await getEphemeralProgram(
      config,
      keypair
    );
    try {
      milestones = await fetchPrivateMilestones(
        erProgram,
        escrowPda,
        programId,
        milestoneIndices
      );
    } catch (error) {
      console.error("Private milestones are not available yet.");
      process.exit(1);
    }
  }

  const metadataByIndex = new Map(
    (contract.milestones || []).map((milestone) => [milestone.index, milestone])
  );
  const ordered = [...milestones].sort((a, b) => a.index - b.index);
  ordered.forEach((milestone) => {
    const meta = metadataByIndex.get(milestone.index) || {};
    const label = getMilestoneLabel(meta);
    const statusLabel = Number.isFinite(milestone.status)
      ? formatPrivateMilestoneStatus(milestone.status)
      : "unknown";
    const suffix = statusLabel === "disabled" ? ` ${chalk.gray("[disabled]")}` : "";
    console.log(`${milestone.index + 1}) ${label}${suffix}`);
  });
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const runMilestoneStatus = async (config, contract, number) => {
  const { keypair, wallet, walletKey } = getWalletContext(config);
  if (!contract.escrow_pda) {
    console.error("Contract has no escrow.");
    process.exit(1);
  }
  if (!ACTIVE_STATUSES.has(contract.status)) {
    console.error(
      "Contract is not in progress. Use: nebulon contract <id> check milestone list"
    );
    process.exit(1);
  }
  const role = getRole(contract, wallet);
  if (role !== "client" && role !== "contractor") {
    console.error("Only contract participants can view milestone details.");
    process.exit(1);
  }

  const index = Number(number) - 1;
  if (!Number.isFinite(index) || index < 0) {
    console.error("Invalid milestone number.");
    process.exit(1);
  }

  const { program, connection, programId } = getProgram(config, keypair);
  const escrowPda = new PublicKey(contract.escrow_pda);
  const escrowState = await getEscrowState(connection, programId, escrowPda);
  if (!escrowState) {
    console.error("Escrow not found on-chain.");
    process.exit(1);
  }

  let milestone;
  if (isL1Mode(contract)) {
    const items = await fetchPublicMilestones(
      program,
      escrowPda,
      programId,
      [index]
    );
    milestone = items[0];
  } else {
    const { program: erProgram } = await getEphemeralProgram(
      config,
      keypair
    );
    try {
      const items = await fetchPrivateMilestones(
        erProgram,
        escrowPda,
        programId,
        [index]
      );
      milestone = items[0];
    } catch (error) {
      console.error("Private milestone is not available yet.");
      process.exit(1);
    }
  }

  const meta = (contract.milestones || []).find((m) => m.index === index) || {};
  const label = getMilestoneLabel(meta);
  const statusLabel = Number.isFinite(milestone.status)
    ? formatPrivateMilestoneStatus(milestone.status)
    : "unknown";
  console.log(`Milestone ${index + 1}: ${label}`);
  console.log(`Status: ${statusLabel}`);
};

const runCheckMilestones = async (config, contract) => {
  const { wallet } = getWalletContext(config);
  const role = getRole(contract, wallet);
  if (role !== "client" && role !== "contractor") {
    console.error("Only contract participants can view milestone details.");
    process.exit(1);
  }
  const milestones = Array.isArray(contract.milestones)
    ? contract.milestones
    : [];
  if (!milestones.length) {
    console.log("Milestones: none");
    return;
  }
  console.log(`Milestones: ${milestones.length}`);
  milestones
    .slice()
    .sort((a, b) => a.index - b.index)
    .forEach((milestone) => {
      const label = getMilestoneLabel(milestone);
      const status = milestone.status ? ` (${milestone.status})` : "";
      console.log(`${milestone.index + 1}) ${label}${status}`);
    });
};

const runContractDetails = async (config, contract) => {
  const { keypair, wallet } = getWalletContext(config);
  const role = getRole(contract, wallet);
  console.log("Contract details");
  console.log(`ID: ${contract.id}`);
  console.log(`Status: ${contract.status}`);
  console.log(`Execution mode: ${getExecutionMode(contract)}`);
  console.log(`Role: ${role}`);
  console.log(
    formatParticipant(
      "Customer",
      contract.client_handle,
      contract.client_wallet,
      wallet
    )
  );
  console.log(
    formatParticipant(
      "Service Provider",
      contract.contractor_handle,
      contract.contractor_wallet,
      wallet
    )
  );
  console.log(`Escrow: ${contract.escrow_pda || "n/a"}`);
  console.log(`Mint: ${contract.mint || "n/a"}`);
  console.log(`Vault: ${contract.vault_token || "n/a"}`);
  const privacyLabel = isL1Mode(contract)
    ? "l1"
    : contract.privacyReady
      ? "ready"
      : "pending";
  console.log(`Privacy: ${privacyLabel}`);

  if (!isL1Mode(contract) && contract.terms_encrypted && !contract.privacyReady) {
    console.log("Terms: encrypted (waiting on privacy keys)");
  } else {
    console.log(`Deadline: ${contract.deadline ? formatDeadlineValue(contract.deadline) : "missing"}`);
    console.log(
      `Payment: ${contract.total_payment ? `${formatUsdc(contract.total_payment)} USDC` : "missing"}`
    );
  }

  const milestones = Array.isArray(contract.milestones)
    ? contract.milestones
    : [];
  console.log(`Milestones: ${milestones.length}`);

  if (!contract.escrow_pda) {
    return;
  }

  const { connection, programId } = getProgram(config, keypair);
  const escrowPda = new PublicKey(contract.escrow_pda);
  const escrowState = await getEscrowState(connection, programId, escrowPda);
  if (!escrowState) {
    console.log("Escrow state: unavailable");
    return;
  }
  console.log("Escrow state:");
  console.log(`  fundedAmount: ${formatUsdc(escrowState.fundedAmount)} USDC`);
  console.log(`  releasedAmount: ${formatUsdc(escrowState.releasedAmount)} USDC`);
  console.log(`  fundingOk: ${escrowState.fundingOk}`);
  console.log(`  readyToClaim: ${escrowState.readyToClaim}`);
  console.log(`  timeoutRefundReady: ${escrowState.timeoutRefundReady}`);
  console.log(`  timeoutFundsReady: ${escrowState.timeoutFundsReady}`);
  console.log(`  disputeOpen: ${escrowState.disputeOpen}`);
  console.log(`  paidOut: ${escrowState.paidOut}`);
};

const runContractStatus = async (config, contract) => {
  const { keypair, wallet } = getWalletContext(config);
  const role = getRole(contract, wallet);
  console.log(`Contract ID: ${contract.id}`);
  console.log(
    formatParticipant(
      "Customer",
      contract.client_handle,
      contract.client_wallet,
      wallet
    )
  );
  console.log(
    formatParticipant(
      "Service Provider",
      contract.contractor_handle,
      contract.contractor_wallet,
      wallet
    )
  );
  if (role && role !== "unknown") {
    console.log(`Role: ${role}`);
  }
  console.log(`Current status: ${contract.status}`);
  console.log(`Execution mode: ${getExecutionMode(contract)}`);
  if (contract.created_at) {
    console.log(`Created: ${formatCreatedAt(contract.created_at)}`);
  }

  let fundedLabel = "unknown";
  if (contract.escrow_pda) {
    const { connection, programId } = getProgram(config, keypair);
    const escrowPda = new PublicKey(contract.escrow_pda);
    const escrowState = await getEscrowState(connection, programId, escrowPda);
    if (escrowState) {
      fundedLabel = escrowState.fundedAmount > 0 ? "yes" : "no";
    }
  }
  console.log(`Is funded: ${fundedLabel}`);
};

const runContractWhoami = async (config, contract) => {
  const { wallet } = getWalletContext(config);
  const role = getRole(contract, wallet);
  renderContractSummary(contract, wallet);
  console.log(`Role: ${role}`);
};

const runContractNowWhat = async (config, contract) => {
  const { wallet } = getWalletContext(config);
  const role = getRole(contract, wallet);
  if (role !== "client" && role !== "contractor") {
    console.error("Only contract participants can use this command.");
    process.exit(1);
  }

  const status = contract.status;
  let message = "No next step available.";

  switch (status) {
    case "waiting_for_init":
      message = "Initialize the escrow: `nebulon contract <id> init`";
      break;
    case "negotiating":
      if (role === "client") {
        message =
          "Set terms and milestones, then sign: `nebulon contract <id> add term ...`, `nebulon contract <id> add milestone ...`, `nebulon contract <id> sign`";
      } else {
        message =
          "Review terms/milestones, then sign: `nebulon contract <id> check terms`, `nebulon contract <id> check milestone list`, `nebulon contract <id> sign`";
      }
      break;
    case "awaiting_signatures":
      message =
        "Waiting on the other party to sign. You can check status with `nebulon contract <id> status`.";
      break;
    case "waiting_for_funding":
      if (role === "client") {
        message = "Fund the contract: `nebulon contract <id> fund`";
      } else {
        message =
          "Waiting for client to fund. You can check status with `nebulon contract <id> status`.";
      }
      break;
    case "waiting_for_milestones_report":
      if (role === "contractor") {
        message =
          "Submit the next milestone: `nebulon contract <id> update milestone <n> ready`";
      } else {
        message =
          "Waiting for contractor to submit a milestone. Use `nebulon contract <id> check milestone list`.";
      }
      break;
    case "in_progress":
      if (role === "contractor") {
        message =
          "Submit the next milestone: `nebulon contract <id> update milestone <n> ready`";
      } else {
        message =
          "Confirm the submitted milestone: `nebulon contract <id> confirm milestone <n>`";
      }
      break;
    case "ready_to_claim":
      if (role === "contractor") {
        message = "Claim funds: `nebulon contract <id> claim_funds`";
      } else {
        message = "Waiting for contractor to claim funds.";
      }
      break;
    case "completed":
      message = "Contract completed. No further actions.";
      break;
    case "dispute_open":
      message = "Dispute is open. Await resolution.";
      break;
    default:
      message = `No guidance for status: ${status}`;
      break;
  }

  console.log(message);
};

const runRateContract = async (config, contract, scoreValue) => {
  const { wallet } = getWalletContext(config);
  const role = getRole(contract, wallet);
  if (role !== "client" && role !== "contractor") {
    console.error("Only contract participants can rate a contract.");
    return;
  }
  if (contract.status !== "completed") {
    console.error("Ratings are only allowed once the contract is completed.");
    return;
  }

  const score = Number.parseInt(scoreValue, 10);
  if (!Number.isInteger(score) || score < 1 || score > 5) {
    console.error("Usage: nebulon contract <id> rate <1-5>");
    return;
  }

  await rateContract(config.backendUrl, config.auth.token, contract.id, score);
  console.log(`Rating submitted: ${score} star${score === 1 ? "" : "s"}.`);
};

const runContractMode = async (config, contract, mode, options) => {
  const { wallet } = getWalletContext(config);
  const role = getRole(contract, wallet);
  if (role !== "client" && role !== "contractor") {
    console.error("Only contract participants can change execution mode.");
    process.exit(1);
  }
  const desired = (mode || "").toString().toLowerCase();
  if (desired !== "per" && desired !== "l1") {
    console.error("Usage: nebulon contract <id> mode per|l1");
    return;
  }
  const allowedStatuses = new Set(["waiting_for_init", "negotiating", "awaiting_signatures"]);
  if (!allowedStatuses.has(contract.status)) {
    console.error("Execution mode can only be changed before funding.");
    return;
  }
  if (desired === getExecutionMode(contract)) {
    console.log(`Execution mode is already ${desired.toUpperCase()}.`);
    return;
  }
  const proceed = await confirmAction(
    options.confirm,
    `Set execution mode to ${desired.toUpperCase()}? yes/no`
  );
  if (!proceed) {
    console.log("Canceled.");
    return;
  }
  await updateContract(config.backendUrl, config.auth.token, contract.id, {
    executionMode: desired,
  });
  contract.execution_mode = desired;
  if (desired === "l1") {
    console.log("L1 MODE enabled for this contract (no TEE privacy).");
  } else {
    console.log("PER mode enabled for this contract.");
  }
};

const runCheckTerms = async (config, contract) => {
  const { wallet } = getWalletContext(config);
  const role = getRole(contract, wallet);
  if (role !== "client" && role !== "contractor") {
    console.error("Only contract participants can view terms.");
    process.exit(1);
  }
  if (!isL1Mode(contract) && contract.terms_encrypted && !contract.privacyReady) {
    console.error("Privacy key exchange pending. Unable to read terms.");
    process.exit(1);
  }
  const deadline = contract.deadline;
  const payment = contract.total_payment;
  console.log(`Deadline : ${deadline ? formatDeadlineValue(deadline) : "missing"}`);
  console.log(
    `Payment  : ${payment ? `${formatUsdc(payment)} USDC` : "missing"}`
  );
};

const runOpenDispute = async (config, contract, options) => {
  const { keypair, wallet, walletKey } = getWalletContext(config);
  if (!contract.escrow_pda) {
    console.error("Contract has no escrow.");
    process.exit(1);
  }
  if (contract.status !== "in_progress") {
    console.error("Disputes can only be opened when the contract is in progress.");
    return;
  }

  console.log("Verify data and confirm actions please.");
  renderContractSummary(contract, wallet);
  console.log("-Action-");
  console.log("Dispute contract");
  console.log("");

  const canProceed = await renderBalancesOrAbort(
    config,
    walletKey,
    contract.mint || config.usdcMint
  );
  if (!canProceed) {
    return;
  }

  const proceed = await confirmAction(options.confirm, "Proceed? yes/no");
  if (!proceed) {
    console.log("Canceled.");
    return;
  }

  const { program, connection, programId } = getProgram(config, keypair);
  const escrowPda = new PublicKey(contract.escrow_pda);
  const escrowState = await getEscrowState(connection, programId, escrowPda);
  if (!escrowState) {
    console.error("Escrow not found on-chain.");
    process.exit(1);
  }
  const escrowId = escrowState.escrowId;
  const disputePda = deriveDisputePda(escrowPda, programId);

  console.log("Processing.");
  try {
    const sig = await program.methods
      .openDispute(new anchor.BN(escrowId.toString()))
      .accounts({
        actor: walletKey,
        escrow: escrowPda,
        dispute: disputePda,
        systemProgram: SystemProgram.programId,
      })
      .signers([keypair])
      .rpc();
    console.log(`Dispute opened. (tx: ${sig})`);
    console.log("Contact @nortbyt3 on Discord to discuss your case.");
    successMessage("Dispute opened.");
  } catch (error) {
    const message = (error && error.message ? error.message : "").toLowerCase();
    if (message.includes("invalidstate")) {
      console.error("Unable to open a dispute in the current contract state.");
      return;
    }
    throw error;
  }
};

const runResolveDispute = async (
  config,
  contract,
  clientPercent,
  contractorPercent,
  options
) => {
  const { keypair, wallet, walletKey } = getWalletContext(config);
  if (!contract.escrow_pda) {
    console.error("Contract has no escrow.");
    process.exit(1);
  }

  console.log("Verify data and confirm actions please.");
  renderContractSummary(contract, wallet);
  console.log("-Action-");
  console.log("Resolve dispute");
  console.log(`Customer : ${clientPercent}%`);
  console.log(`Service Provider : ${contractorPercent}%`);
  console.log("");

  const canProceed = await renderBalancesOrAbort(
    config,
    walletKey,
    contract.mint || config.usdcMint
  );
  if (!canProceed) {
    return;
  }

  const proceed = await confirmAction(options.confirm, "Proceed? yes/no");
  if (!proceed) {
    console.log("Canceled.");
    return;
  }

  const { program, connection, programId } = getProgram(config, keypair);
  const escrowPda = new PublicKey(contract.escrow_pda);
  const escrowState = await getEscrowState(connection, programId, escrowPda);
  if (!escrowState) {
    console.error("Escrow not found on-chain.");
    process.exit(1);
  }
  const escrowId = escrowState.escrowId;
  const disputePda = deriveDisputePda(escrowPda, programId);
  const mint = new PublicKey(contract.mint || config.usdcMint);

  const clientToken = await ensureAta(
    connection,
    keypair,
    new PublicKey(contract.client_wallet),
    mint
  );
  const contractorToken = await ensureAta(
    connection,
    keypair,
    new PublicKey(contract.contractor_wallet),
    mint
  );
  const vaultToken = await getAssociatedTokenAddress(mint, escrowPda, true);

  console.log("Processing.");
  try {
    const sig = await program.methods
      .resolveDisputeSplit(
        new anchor.BN(escrowId.toString()),
        Number(clientPercent),
        Number(contractorPercent)
      )
      .accounts({
        judge: walletKey,
        escrow: escrowPda,
        dispute: disputePda,
        clientToken,
        contractorToken,
        vaultToken,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([keypair])
      .rpc();
    console.log(`Dispute resolved. (tx: ${sig})`);
    successMessage("Dispute resolved.");
  } catch (error) {
    const message = (error && error.message ? error.message : "").toLowerCase();
    if (message.includes("invalidstate")) {
      console.error("Unable to resolve a dispute in the current contract state.");
      return;
    }
    if (message.includes("nodispute")) {
      console.error("No open dispute to resolve.");
      return;
    }
    throw error;
  }
};

const runContractCommand = async (args, options = {}) => {
  const config = loadConfig();
  await ensureHosted(config);

  if (!args.length) {
    console.log("Usage: nebulon contract <action>");
    return;
  }

  const [head, ...rest] = args;
  const normalized = head.toLowerCase();

  if (normalized === "create") {
    await runContractsCreate();
    return;
  }
  if (normalized === "list") {
    await runContractsShow("all", options);
    return;
  }
  if (normalized === "show") {
    await runContractsShow(rest[0] || "all", options);
    return;
  }
  if (normalized === "active") {
    await runContractsShow("active", options);
    return;
  }
  if (normalized === "disputed") {
    await runContractsShow("disputed", options);
    return;
  }
  if (normalized === "isfunded") {
    const contract = await resolveContract(config, rest[0] || target);
    if (!contract) {
      console.error("Contract not found.");
      process.exit(1);
    }
    const { keypair } = getWalletContext(config);
    if (!contract.escrow_pda) {
      console.log("Is funded: no (escrow not initialized)");
      return;
    }
    const { connection, programId } = getProgram(config, keypair);
    const escrowPda = new PublicKey(contract.escrow_pda);
    const escrowState = await getEscrowState(connection, programId, escrowPda);
    if (!escrowState) {
      console.log("Is funded: unknown");
      return;
    }
    console.log(`Is funded: ${escrowState.fundedAmount > 0 ? "yes" : "no"}`);
    return;
  }
  if (normalized === "status") {
    const contract = await resolveContract(config, rest[0] || target);
    if (!contract) {
      console.error("Contract not found.");
      process.exit(1);
    }
    await runContractStatus(config, contract);
    return;
  }

  const target = head;
  const contract = await resolveContract(config, target);
  if (!contract) {
    console.error("Contract not found.");
    process.exit(1);
  }

  if (!rest.length) {
    console.log("Usage: nebulon contract <id|index> <action>");
    return;
  }

  const action = rest[0].toLowerCase();
  if (action === "init") {
    await runInitContract(config, contract, options);
    return;
  }
  if (action === "details") {
    await runContractDetails(config, contract);
    return;
  }
  if (action === "status") {
    await runContractStatus(config, contract);
    return;
  }
  if (action === "add" && rest[1] === "milestone") {
    const title = rest.slice(2).join(" ").trim();
    if (!title) {
      console.error("Milestone description required.");
      return;
    }
    await runAddMilestone(config, contract, title, options);
    return;
  }
  if (action === "milestone" && rest[1] === "list") {
    await runMilestoneList(config, contract);
    return;
  }
  if (action === "term" && rest[1] === "list") {
    await runCheckTerms(config, contract);
    return;
  }
  if (action === "milestone" && rest[1] && rest[2] === "status") {
    await runMilestoneStatus(config, contract, rest[1]);
    return;
  }
  if (action === "whoami") {
    await runContractWhoami(config, contract);
    return;
  }
  if (action === "nowwhat") {
    await runContractNowWhat(config, contract);
    return;
  }
  if (action === "rate") {
    await runRateContract(config, contract, rest[1]);
    return;
  }
  if (action === "mode") {
    await runContractMode(config, contract, rest[1], options);
    return;
  }

  if (action === "disable" && rest[1] === "milestone") {
    if (!rest[2]) {
      console.error("Usage: nebulon contract <id> disable milestone <n>");
      return;
    }
    await runDisableMilestone(config, contract, rest[2], options);
    return;
  }

  if (action === "add" && rest[1] === "term") {
    const field = (rest[2] || "").toLowerCase();
    const value = rest.slice(3).join(" ").trim();
    if (!field || !value) {
      console.error(
        "Usage: nebulon contract <id> add term <deadline|payment> <value>"
      );
      return;
    }
    await runAddTerm(config, contract, field, value, options);
    return;
  }

  if (action === "sign") {
    await runSignContract(config, contract, options);
    return;
  }

  if (action === "fund") {
    await runFundContract(config, contract, options);
    return;
  }

  if (
    action === "milestone" &&
    rest[1] &&
    (rest[2] === "ready" || rest[2] === "setready")
  ) {
    await runUpdateMilestone(config, contract, rest[1], options);
    return;
  }

  if (action === "milestone" && rest[1] && rest[2] === "confirm") {
    await runConfirmMilestone(config, contract, rest[1], options);
    return;
  }

  if (action === "claim_funds") {
    await runClaimFunds(config, contract, options);
    return;
  }

  if (action === "sync") {
    await runSyncFlags(config, contract, options);
    return;
  }

  if (action === "dispute") {
    await runOpenDispute(config, contract, options);
    return;
  }

  if (action === "resolve_dispute") {
    if (rest.length < 3) {
      console.error(
        "Usage: nebulon contract <id> resolve_dispute <customer%> <provider%>"
      );
      return;
    }
    await runResolveDispute(config, contract, rest[1], rest[2], options);
    return;
  }

  console.error("Unknown contract command.");
};

module.exports = {
  runContractCommand,
};

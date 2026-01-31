const { prompt } = require("enquirer");
const { loadConfig } = require("../config");
const { ensureHostedSession } = require("../session");
const {
  getInvites,
  acceptInviteById,
  declineInvite,
  setContractKey,
  getContractKeys,
  getContract,
} = require("../hosted");
const { ensureContractKeypair } = require("../privacy");
const { successMessage } = require("../ui");

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

const formatHandle = (handle, wallet) => {
  if (handle) {
    return `@${handle}`;
  }
  if (wallet) {
    return `${wallet.slice(0, 4)}...${wallet.slice(-4)}`;
  }
  return "n/a";
};

const resolveOptions = (options) => {
  if (!options) {
    return {};
  }
  if (typeof options.opts === "function") {
    return options.opts();
  }
  return options;
};

const printInvites = (invites, options = {}) => {
  const resolved = resolveOptions(options);
  const label = resolved.showAll ? "Nebulon Invites (All)" : "Nebulon Invites";
  console.log(label);
  if (!invites.length) {
    console.log("No invites found.");
    return;
  }
  console.log("#  Type      Status    Role        Contract ID                           From          Date");
  invites.forEach((invite, index) => {
    const row = [
      String(index + 1).padEnd(3, " "),
      String(invite.type).padEnd(9, " "),
      String(invite.status).padEnd(9, " "),
      String(invite.role).padEnd(11, " "),
      String(invite.contractId).padEnd(36, " "),
      String(invite.counterparty || "n/a").padEnd(12, " "),
      invite.createdAt,
    ];
    console.log(row.join(" "));
  });
};

const runInviteList = async (filter, options = {}) => {
  const config = loadConfig();
  if (config.mode !== "hosted") {
    console.error("Direct mode invites are not implemented yet.");
    process.exit(1);
  }
  try {
    await ensureHostedSession(config, { quiet: true, requireHandle: true });
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }

  const result = await getInvites(config.backendUrl, config.auth.token);
  const sent = Array.isArray(result.sent) ? result.sent : [];
  const received = Array.isArray(result.received) ? result.received : [];
  const resolved = resolveOptions(options);
  let showAll = Boolean(resolved.showAll);
  if (!showAll && Array.isArray(process.argv)) {
    showAll = process.argv.includes("--show-all");
  }
  if (typeof filter === "string" && filter.trim().toLowerCase() === "--show-all") {
    showAll = true;
    filter = null;
  }
  const pendingOnly = !showAll;
  const sentFiltered = pendingOnly
    ? sent.filter((invite) => invite.status === "pending")
    : sent;
  const receivedFiltered = pendingOnly
    ? received.filter((invite) => invite.status === "pending")
    : received;

  const sentRows = sentFiltered.map((invite) => ({
    type: "sent",
    status: invite.status,
    role: invite.invitee_role || "n/a",
    contractId: invite.contract_id,
    counterparty: invite.invitee_handle
      ? `@${invite.invitee_handle}`
      : invite.invitee_wallet
        ? formatHandle(null, invite.invitee_wallet)
        : "link",
    createdAt: formatCreatedAt(invite.created_at),
  }));

  const receivedRows = receivedFiltered.map((invite) => ({
    type: "received",
    status: invite.status,
    role: invite.invitee_role || "n/a",
    contractId: invite.contract_id,
    counterparty: formatHandle(invite.issuer_handle, invite.issuer_wallet),
    createdAt: formatCreatedAt(invite.created_at),
  }));

  let rows = [...receivedRows, ...sentRows];
  if (filter === "sent") {
    rows = sentRows;
  } else if (filter === "received") {
    rows = receivedRows;
  }

  printInvites(rows, options);
  return { sent: sentFiltered, received: receivedFiltered, sentRows, receivedRows };
};

const resolveInviteSelection = (received, target) => {
  const matchByIndex = Number.parseInt(target, 10);
  if (!Number.isNaN(matchByIndex)) {
    const idx = matchByIndex - 1;
    if (idx >= 0 && idx < received.length) {
      return received[idx];
    }
    return null;
  }
  return received.find(
    (invite) =>
      invite.contract_id === target || invite.id === target
  );
};

const resolveInviteSelectionAll = (received, sent, target) => {
  const combined = [...received, ...sent];
  const matchByIndex = Number.parseInt(target, 10);
  if (!Number.isNaN(matchByIndex)) {
    const idx = matchByIndex - 1;
    if (idx >= 0 && idx < combined.length) {
      return combined[idx];
    }
    return null;
  }
  return combined.find(
    (invite) =>
      invite.contract_id === target || invite.id === target
  );
};

const renderInviteDetails = (invite) => {
  console.log("Invite details");
  console.log(`Contract ID: ${invite.contract_id}`);
  console.log(
    `From: ${formatHandle(invite.issuer_handle, invite.issuer_wallet)}`
  );
  console.log(`Created: ${formatCreatedAt(invite.created_at)}`);
  console.log("");
};

const renderInviteStatus = async (config, invite) => {
  const detail = await getContract(
    config.backendUrl,
    config.auth.token,
    invite.contract_id
  );
  const contract = detail.contract;
  if (!contract) {
    console.error("Contract not found.");
    process.exit(1);
  }
  const customer = formatHandle(contract.client_handle, contract.client_wallet);
  const provider = formatHandle(
    contract.contractor_handle,
    contract.contractor_wallet
  );
  const selfWallet = config.auth.wallet;
  const role =
    contract.client_wallet === selfWallet
      ? "client"
      : contract.contractor_wallet === selfWallet
        ? "contractor"
        : "other";
  console.log(`Invite ID: ${invite.id}`);
  console.log(`Customer: ${customer}${contract.client_wallet === selfWallet ? " (YOU)" : ""}`);
  console.log(
    `Service Provider: ${provider}${contract.contractor_wallet === selfWallet ? " (YOU)" : ""}`
  );
  console.log(`Role: ${role}`);
  console.log("");
  console.log(`Current status: ${invite.status}`);
};

const runInviteAction = async (target, action) => {
  const config = loadConfig();
  if (config.mode !== "hosted") {
    console.error("Direct mode invites are not implemented yet.");
    process.exit(1);
  }
  try {
    await ensureHostedSession(config, { quiet: true, requireHandle: true });
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }

  if (!target) {
    console.log("Usage: nebulon invite <index|contractId> [accept|deny]");
    return;
  }

  const result = await getInvites(config.backendUrl, config.auth.token);
  const receivedAll = Array.isArray(result.received) ? result.received : [];
  const sentAll = Array.isArray(result.sent) ? result.sent : [];
  const receivedPending = receivedAll.filter((invite) => invite.status === "pending");
  const actionKey = (action || "").toLowerCase();
  const invite =
    actionKey === "status"
      ? resolveInviteSelectionAll(receivedAll, sentAll, target.trim())
      : resolveInviteSelection(receivedPending, target.trim());
  if (!invite) {
    console.error("Invite not found.");
    process.exit(1);
  }

  if (actionKey === "status") {
    await renderInviteStatus(config, invite);
    return;
  }

  renderInviteDetails(invite);

  const normalizeDecision = (value) => {
    if (!value) {
      return null;
    }
    const lowered = value.trim().toLowerCase();
    if (["accept", "a", "yes", "y"].includes(lowered)) {
      return "accept";
    }
    if (["deny", "decline", "d", "no", "n"].includes(lowered)) {
      return "deny";
    }
    return null;
  };

  let decision = normalizeDecision(action);
  if (!decision) {
    const answer = await prompt({
      type: "input",
      name: "decision",
      message: "Do you want to accept this invite? (yes/no)",
      initial: "yes",
      validate: (value) =>
        normalizeDecision(value) ? true : "Type yes or no.",
    });
    decision = normalizeDecision(answer.decision);
  }

  if (!decision) {
    console.log("Usage: nebulon invite <index|contractId> [accept|deny]");
    return;
  }

  try {
    if (decision === "accept") {
      const accepted = await acceptInviteById(
          config.backendUrl,
          config.auth.token,
          { inviteId: invite.id }
        );
        console.log("Invite accepted.");
        console.log(`Contract ID: ${accepted.contractId}`);
        console.log(`Status: ${accepted.status}`);
        // Fetch complete contract data to ensure we have escrow_pda
        const contractDetail = await getContract(
          config.backendUrl,
          config.auth.token,
          accepted.contractId
        );
      console.log("Setting up privacy keys...");
      try {
        const keypair = ensureContractKeypair(config, accepted.contractId);
        await setContractKey(
          config.backendUrl,
          config.auth.token,
          accepted.contractId,
          keypair.publicKey
        );
        const keys = await getContractKeys(
          config.backendUrl,
          config.auth.token,
          accepted.contractId
        );
        const count = Array.isArray(keys.keys) ? keys.keys.length : 0;
        if (count > 1) {
          console.log("Privacy key exchange complete.");
        } else {
          console.log("Privacy key registered. Awaiting counterparty.");
        }
      } catch (error) {
        console.log("Privacy key setup pending. Try again later.");
      }
      successMessage("Invite accepted.");
      return;
    }

    const declined = await declineInvite(
      config.backendUrl,
      config.auth.token,
      { inviteId: invite.id }
    );
    console.log("Invite declined.");
    console.log(`Contract ID: ${declined.contractId}`);
    console.log(`Status: ${declined.status}`);
    successMessage("Invite declined.");
  } catch (error) {
    if (error && error.message === "Not Found") {
      console.error("Invite action failed: backend missing invite action routes.");
      console.error("Restart the backend after updating to the latest code.");
      process.exit(1);
    }
    throw error;
  }
};

module.exports = {
  runInviteList,
  runInviteAction,
};

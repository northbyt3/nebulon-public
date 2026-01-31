require("dotenv").config();

const crypto = require("crypto");
const bs58 = require("bs58");
const { Connection, PublicKey } = require("@solana/web3.js");
const { db } = require("./db");
const {
  SOLANA_RPC_URL,
  PROGRAM_ID,
  INDEXER_INTERVAL_SECONDS,
  DELEGATION_PROGRAM_ID,
} = require("./config");
const { nowSeconds } = require("./utils/time");

const connection = new Connection(SOLANA_RPC_URL, "confirmed");
const programId = new PublicKey(PROGRAM_ID);
const delegationProgramId = new PublicKey(DELEGATION_PROGRAM_ID);
const anchorDiscriminator = (name) =>
  crypto
    .createHash("sha256")
    .update(`account:${name}`)
    .digest()
    .subarray(0, 8);

const ESCROW_DISCRIMINATOR = anchorDiscriminator("Escrow");
const MILESTONE_DISCRIMINATOR = anchorDiscriminator("Milestone");

const hasDiscriminator = (data, discriminator) => {
  if (!data || data.length < 8) {
    return false;
  }
  return data.subarray(0, 8).equals(discriminator);
};

const readPubkey = (data, offset) =>
  new PublicKey(data.subarray(offset, offset + 32));

const readU64 = (data, offset) => data.readBigUInt64LE(offset);
const readI64 = (data, offset) => data.readBigInt64LE(offset);

const decodeEscrow = (data) => {
  let offset = 8;
  const creator = readPubkey(data, offset);
  offset += 32;
  const client = readPubkey(data, offset);
  offset += 32;
  const contractor = readPubkey(data, offset);
  offset += 32;
  const mint = readPubkey(data, offset);
  offset += 32;
  const vaultToken = readPubkey(data, offset);
  offset += 32;
  const perVault = readPubkey(data, offset);
  offset += 32;
  const escrowId = readU64(data, offset);
  offset += 8;
  const termsHash = data.subarray(offset, offset + 32);
  offset += 32;
  const milestonesHash = data.subarray(offset, offset + 32);
  offset += 32;
  const fundedAmount = readU64(data, offset);
  offset += 8;
  const releasedAmount = readU64(data, offset);
  offset += 8;
  const fundedAt = readI64(data, offset);
  offset += 8;
  const disputeOpen = data.readUInt8(offset) !== 0;
  offset += 1;
  const paidOut = data.readUInt8(offset) !== 0;
  offset += 1;
  const fundingOk = data.readUInt8(offset) !== 0;
  offset += 1;
  const readyToClaim = data.readUInt8(offset) !== 0;
  offset += 1;
  const timeoutRefundReady = data.readUInt8(offset) !== 0;
  offset += 1;
  const timeoutFundsReady = data.readUInt8(offset) !== 0;
  offset += 1;
  const judge = readPubkey(data, offset);
  offset += 32;
  const bump = data.readUInt8(offset);
  offset += 1;
  const perVaultBump = data.readUInt8(offset);

  return {
    creator,
    client,
    contractor,
    mint,
    vaultToken,
    perVault,
    escrowId,
    termsHash,
    milestonesHash,
    fundedAmount,
    releasedAmount,
    fundedAt,
    disputeOpen,
    paidOut,
    fundingOk,
    readyToClaim,
    timeoutRefundReady,
    timeoutFundsReady,
    judge,
    bump,
    perVaultBump,
  };
};

const decodeMilestone = (data) => {
  let offset = 8;
  const escrow = readPubkey(data, offset);
  offset += 32;
  const index = data.readUInt8(offset);
  offset += 1;
  const status = data.readUInt8(offset);
  offset += 1;
  const submittedAt = readI64(data, offset);

  return { escrow, index, status, submittedAt };
};

const hasSubmittedMilestone = async (escrowPda) => {
  const filters = [
    {
      memcmp: {
        offset: 0,
        bytes: bs58.encode(MILESTONE_DISCRIMINATOR),
      },
    },
    {
      memcmp: {
        offset: 8,
        bytes: escrowPda.toBase58(),
      },
    },
  ];
  const accounts = await connection.getProgramAccounts(programId, {
    filters,
  });
  for (const account of accounts) {
    if (!hasDiscriminator(account.account.data, MILESTONE_DISCRIMINATOR)) {
      continue;
    }
    const milestone = decodeMilestone(account.account.data);
    if (milestone.status >= 1 && milestone.status !== 4) {
      return true;
    }
  }
  return false;
};

const hasLockedTerms = (contract) => {
  if (!contract) {
    return false;
  }
  const hasHash = Boolean(contract.terms_hash);
  const hasPlainTerms = Boolean(contract.deadline && contract.total_payment);
  const hasEncryptedTerms = Boolean(contract.terms_encrypted);
  const hasSignatures = Boolean(
    contract.client_signed_at && contract.contractor_signed_at
  );
  return hasHash && (hasPlainTerms || hasEncryptedTerms) && hasSignatures;
};

const computeStatus = async (escrowPda, escrow, contract, currentStatus) => {
  if (
    currentStatus === "canceled" ||
    currentStatus === "invite_canceled" ||
    currentStatus === "invite_expired"
  ) {
    return currentStatus;
  }

  // If paid out or fully released, mark as completed
  if (escrow.paidOut) {
    return "completed";
  }
  if (escrow.releasedAmount > 0n && escrow.fundedAmount === 0n && !escrow.fundingOk) {
    return "completed";
  }

  if (escrow.disputeOpen) {
    return "disputed";
  }

  if (escrow.timeoutRefundReady) {
    return "ready_to_claim";
  }
  if (escrow.readyToClaim || escrow.timeoutFundsReady) {
    return "ready_to_claim";
  }
  if (escrow.fundingOk) {
    return "in_progress";
  }
  if (escrow.fundedAmount > 0n) {
    return "waiting_for_milestones_report";
  }
  if (escrow.termsHash && escrow.termsHash.some((byte) => byte !== 0)) {
    if (hasLockedTerms(contract)) {
      return "waiting_for_funding";
    }
    if (contract.execution_mode === "l1") {
      return "awaiting_signatures";
    }
    return "negotiating";
  }

  return currentStatus;
};

const updateContractStatus = (contractId, status) => {
  db.prepare("UPDATE contract_drafts SET status = ?, updated_at = ? WHERE id = ?").run(
    status,
    nowSeconds(),
    contractId
  );
};

const processContract = async (contract, verbose = false) => {
  if (!contract.escrow_pda) {
    if (verbose) console.log(`Contract ${contract.id} has no escrow_pda, skipping`);
    return;
  }
  if (verbose) console.log(`Contract ${contract.id} has escrow_pda: ${contract.escrow_pda} (type: ${typeof contract.escrow_pda}, length: ${contract.escrow_pda.length})`);
  if (!contract.escrow_pda || typeof contract.escrow_pda !== 'string' || contract.escrow_pda.length !== 44) {
    if (verbose) console.log(`Contract ${contract.id} has invalid escrow_pda: ${contract.escrow_pda} (type: ${typeof contract.escrow_pda})`);
    return;
  }
  let escrowKey;
  try {
    escrowKey = new PublicKey(contract.escrow_pda);
  } catch (error) {
    if (verbose) console.log(`Contract ${contract.id} invalid escrow_pda format: ${error.message}`);
    return;
  }

  const accountInfo = await connection.getAccountInfo(escrowKey, "confirmed");
  if (verbose) console.log(`Escrow account ${escrowKey.toBase58()} ${accountInfo ? 'found' : 'not found'}`);
  if (!accountInfo) {
    if (verbose) console.log(`Escrow account ${escrowKey.toBase58()} not found`);
    // If escrow account is not found, mark as completed regardless of current status
    updateContractStatus(contract.id, "completed");
    if (verbose) {
      console.log(`contract ${contract.id} -> completed (escrow closed)`);
    }
    return;
  }
  if (
    !accountInfo.owner.equals(programId) &&
    !accountInfo.owner.equals(delegationProgramId)
  ) {
    if (verbose) {
      console.log(
        `Escrow account ${escrowKey.toBase58()} owned by ${accountInfo.owner.toBase58()}, expected ${programId.toBase58()} or ${delegationProgramId.toBase58()}`
      );
    }
    return;
  }
  if (!hasDiscriminator(accountInfo.data, ESCROW_DISCRIMINATOR)) {
    return;
  }
  if (accountInfo.data.length < 336) {
    if (verbose) {
      console.log(`Escrow account ${escrowKey.toBase58()} data too short`);
    }
    return;
  }

  const escrow = decodeEscrow(accountInfo.data);
  const nextStatus = await computeStatus(
    escrowKey,
    escrow,
    contract,
    contract.status
  );
  if (nextStatus !== contract.status) {
    if (verbose) {
      console.log(`UPDATING contract ${contract.id} from ${contract.status} to ${nextStatus} (escrow: ${escrowKey.toBase58()})`);
    }
    updateContractStatus(contract.id, nextStatus);
    if (verbose) {
      console.log(`contract ${contract.id} -> ${nextStatus}`);
    }
  }
};

const tick = async (verbose = false) => {
  const contracts = db
    .prepare(
      "SELECT id, status, escrow_pda, terms_hash, terms_encrypted, deadline, total_payment, client_signed_at, contractor_signed_at, execution_mode FROM contract_drafts WHERE escrow_pda IS NOT NULL"
    )
    .all();
  if (verbose) {
  console.log(`Indexer tick: found ${contracts.length} contracts with escrow_pda`);
  if (verbose) {
    console.log("Contract IDs:", contracts.map(c => c.id));
  }
  }
  for (const contract of contracts) {
    try {
      await processContract(contract, verbose);
    } catch (error) {
      console.error("indexer error", contract.id, error.message);
    }
  }
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const startIndexer = async () => {
  console.log(`Indexer running for program : ${PROGRAM_ID}`);
  try {
    const programInfo = await connection.getAccountInfo(programId, "confirmed");
    if (!programInfo) {
      console.warn(
        `Unable to verify program ${PROGRAM_ID} on ${SOLANA_RPC_URL}.`
      );
    }
  } catch (error) {
    console.warn(
      `Unable to verify program ${PROGRAM_ID} on ${SOLANA_RPC_URL}.`
    );
  }
  while (true) {
    await tick(false); // quiet mode for automatic indexing
    await sleep(INDEXER_INTERVAL_SECONDS * 1000);
  }
};

if (require.main === module) {
  startIndexer().catch((error) => {
    console.error("indexer fatal", error);
    process.exit(1);
  });
}

module.exports = { startIndexer, tick, processContract };

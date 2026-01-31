const crypto = require("crypto");
const { Connection, PublicKey } = require("@solana/web3.js");
const { DELEGATION_PROGRAM_ID } = require("@magicblock-labs/ephemeral-rollups-sdk");
const {
  getAssociatedTokenAddress,
  getAccount,
  getMint,
} = require("@solana/spl-token");

const toSol = (lamports) => lamports / 1_000_000_000;

const formatAmount = (value, decimals = 6) =>
  Number(value).toFixed(decimals);

const getConnection = (rpcUrl) => new Connection(rpcUrl, "confirmed");

const getSolBalance = async (connection, wallet) => {
  const lamports = await connection.getBalance(wallet);
  return toSol(lamports);
};

const getTokenBalance = async (connection, owner, mint) => {
  try {
    const mintInfo = await getMint(connection, mint);
    const ata = await getAssociatedTokenAddress(mint, owner);
    const account = await getAccount(connection, ata);
    const raw = Number(account.amount);
    return raw / 10 ** mintInfo.decimals;
  } catch (error) {
    return 0;
  }
};

const toPublicKey = (value) => new PublicKey(value);

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

const getEscrowMilestoneCounts = async (connection, programId, escrowPda) => {
  return null;
};

const decodeEscrow = (data) => {
  let offset = 8;
  const creator = new PublicKey(data.subarray(offset, offset + 32));
  offset += 32;
  const client = new PublicKey(data.subarray(offset, offset + 32));
  offset += 32;
  const contractor = new PublicKey(data.subarray(offset, offset + 32));
  offset += 32;
  const mint = new PublicKey(data.subarray(offset, offset + 32));
  offset += 32;
  const vaultToken = new PublicKey(data.subarray(offset, offset + 32));
  offset += 32;
  const perVault = new PublicKey(data.subarray(offset, offset + 32));
  offset += 32;
  const escrowId = data.readBigUInt64LE(offset);
  offset += 8;
  const termsHash = data.subarray(offset, offset + 32);
  offset += 32;
  const milestonesHash = data.subarray(offset, offset + 32);
  offset += 32;
  const fundedAmount = data.readBigUInt64LE(offset);
  offset += 8;
  const releasedAmount = data.readBigUInt64LE(offset);
  offset += 8;
  const fundedAt = Number(data.readBigInt64LE(offset));
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
  const judge = new PublicKey(data.subarray(offset, offset + 32));
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

const getEscrowState = async (connection, programId, escrowPda) => {
  if (!escrowPda) {
    return null;
  }
  const escrowKey = toPublicKey(escrowPda);
  const info = await connection.getAccountInfo(escrowKey, "confirmed");
  if (!info) {
    return null;
  }
  const isDelegated = info.owner.equals(DELEGATION_PROGRAM_ID);
  if (
    !info.owner.equals(programId) &&
    !isDelegated
  ) {
    return null;
  }
  if (!hasDiscriminator(info.data, ESCROW_DISCRIMINATOR)) {
    return null;
  }
  if (info.data.length < 336) {
    return null;
  }
  const decoded = decodeEscrow(info.data);
  decoded._ownerIsDelegated = isDelegated;
  return decoded;
};

const decodeMilestone = (data) => {
  let offset = 8;
  const escrow = new PublicKey(data.subarray(offset, offset + 32));
  offset += 32;
  const index = data.readUInt8(offset);
  offset += 1;
  const status = data.readUInt8(offset);
  offset += 1;
  const submittedAt = data.readBigInt64LE(offset);
  offset += 8;
  const creator =
    data.length >= offset + 32
      ? new PublicKey(data.subarray(offset, offset + 32))
      : null;
  return { escrow, index, status, submittedAt, creator };
};

const getMilestoneState = async (connection, programId, milestonePda) => {
  if (!milestonePda) {
    return null;
  }
  const info = await connection.getAccountInfo(milestonePda, "confirmed");
  if (!info) {
    return null;
  }
  if (!info.owner.equals(programId)) {
    return null;
  }
  if (!hasDiscriminator(info.data, MILESTONE_DISCRIMINATOR)) {
    return null;
  }
  return decodeMilestone(info.data);
};

module.exports = {
  formatAmount,
  getConnection,
  getSolBalance,
  getTokenBalance,
  toPublicKey,
  getEscrowMilestoneCounts,
  getEscrowState,
  getMilestoneState,
};

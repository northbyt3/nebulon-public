const express = require("express");
const {
  SOLANA_RPC_URL,
  SOLANA_WS_URL,
  SOLANA_NETWORK,
  EPHEMERAL_PROVIDER_ENDPOINT,
  EPHEMERAL_WS_ENDPOINT,
  EPHEMERAL_VALIDATOR_IDENTITY,
  EPHEMERAL_PERMISSION_ENDPOINT,
  EPHEMERAL_TEE_ENDPOINT,
  EPHEMERAL_TEE_WS_ENDPOINT,
  PROGRAM_ID,
  FAUCET_ENABLED,
} = require("../config");
const { deriveWsUrl, normalizeNetwork } = require("../utils/network");
const { getMintPublicKey } = require("../utils/faucet-mint");

const router = express.Router();

router.get("/", (req, res) => {
  const network = normalizeNetwork(SOLANA_RPC_URL, SOLANA_NETWORK);
  const wsUrl = SOLANA_WS_URL || deriveWsUrl(SOLANA_RPC_URL);
  let mint = null;
  try {
    mint = getMintPublicKey();
  } catch (error) {
    mint = null;
  }

  return res.json({
    ok: true,
    network,
    rpcUrl: SOLANA_RPC_URL,
    wsUrl,
    ephemeralProviderUrl: EPHEMERAL_PROVIDER_ENDPOINT || null,
    ephemeralWsUrl: EPHEMERAL_WS_ENDPOINT || null,
    ephemeralValidatorIdentity: EPHEMERAL_VALIDATOR_IDENTITY || null,
    ephemeralPermissionEndpoint: EPHEMERAL_PERMISSION_ENDPOINT || null,
    ephemeralTeeEndpoint: EPHEMERAL_TEE_ENDPOINT || null,
    ephemeralTeeWsEndpoint: EPHEMERAL_TEE_WS_ENDPOINT || null,
    programId: PROGRAM_ID,
    usdcMint: mint ? mint.toBase58() : null,
    faucetEnabled: FAUCET_ENABLED,
  });
});

module.exports = router;

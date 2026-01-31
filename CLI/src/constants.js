const PROGRAM_ID_DEFAULT = "6UqkmQ2iCkf3acBB71DdXtVd49EyuaftMz8V3E74USbC";
const TUSDC_MINT_DEFAULT = "HwhrDAorVU2YSHUghNQgxHKBWJyYbvEYC9EC5XBoKNEM";
const USDC_MINT_MAINNET = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

const NETWORK_PRESETS = {
  localnet: {
    rpcUrl: "http://127.0.0.1:8899",
    wsUrl: "ws://127.0.0.1:8900",
    usdcMint: TUSDC_MINT_DEFAULT,
  },
  devnet: {
    rpcUrl: "https://api.devnet.solana.com",
    wsUrl: "wss://api.devnet.solana.com",
    usdcMint: TUSDC_MINT_DEFAULT,
  },
  mainnet: {
    rpcUrl: "https://api.mainnet-beta.solana.com",
    wsUrl: "wss://api.mainnet-beta.solana.com",
    usdcMint: USDC_MINT_MAINNET,
  },
};

const DEFAULT_CONFIG = {
  mode: "hosted",
  network: "localnet",
  rpcUrl: NETWORK_PRESETS.localnet.rpcUrl,
  wsUrl: NETWORK_PRESETS.localnet.wsUrl,
  programId: PROGRAM_ID_DEFAULT,
  backendUrl: "http://174.138.42.117:3333",
  usdcMint: NETWORK_PRESETS.localnet.usdcMint,
  programIdSource: "custom",
  usdcMintSource: "custom",
  rpcUrlSource: "custom",
  wsUrlSource: "custom",
  ephemeralProviderUrlSource: "custom",
  ephemeralWsUrlSource: "custom",
  ephemeralValidatorIdentitySource: "custom",
  ephemeralPermissionEndpointSource: "custom",
  ephemeralTeeEndpointSource: "custom",
  ephemeralTeeWsEndpointSource: "custom",
  networkSource: "custom",
  backendSource: "official",
  ephemeralProviderUrl: "",
  ephemeralWsUrl: "",
  ephemeralValidatorIdentity: "",
  ephemeralPermissionEndpoint: "",
  ephemeralTeeEndpoint: "",
  ephemeralTeeWsEndpoint: "",
  activeWallet: null,
  wallets: {},
  sessions: {},
  privacy: {
    contractKeys: {},
  },
  auth: {
    token: null,
    wallet: null,
    handle: null,
    role: null,
    lastAuthAt: null,
  },
};

module.exports = {
  DEFAULT_CONFIG,
  NETWORK_PRESETS,
  PROGRAM_ID_DEFAULT,
  TUSDC_MINT_DEFAULT,
  USDC_MINT_MAINNET,
};

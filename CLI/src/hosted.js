const bs58Module = require("bs58");
const nacl = require("tweetnacl");

const bs58 =
  (bs58Module && bs58Module.encode && bs58Module) ||
  (bs58Module && bs58Module.default && bs58Module.default);

const encodeBase58 = (value) => {
  if (!bs58 || typeof bs58.encode !== "function") {
    throw new Error("Base58 encoder unavailable.");
  }
  return bs58.encode(value);
};

const ensureUrl = (baseUrl, path) =>
  `${baseUrl.replace(/\/$/, "")}${path}`;

const fetchJson = async (url, options = {}) => {
  const res = await fetch(url, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
  });
  let data = null;
  let parseError = null;
  try {
    data = await res.json();
  } catch (error) {
    parseError = error;
  }
  if (!res.ok) {
    const message = (data && (data.error || data.message)) || res.statusText;
    const error = new Error(message);
    error.data = data;
    error.status = res.status;
    throw error;
  }
  if (parseError) {
    const text = await res.text().catch(() => "");
    const preview = text ? text.slice(0, 200).replace(/\s+/g, " ") : "n/a";
    throw new Error(
      `Unexpected non-JSON response from ${url} (status ${res.status}). Body: ${preview}`
    );
  }
  return data || {};
};

const getChallenge = async (baseUrl, wallet) =>
  fetchJson(ensureUrl(baseUrl, "/v1/auth/challenge"), {
    method: "POST",
    body: JSON.stringify({ wallet }),
  });

const signChallenge = (keypair, message) => {
  const messageBytes = Buffer.from(message, "utf8");
  const signatureBytes = nacl.sign.detached(messageBytes, keypair.secretKey);
  return encodeBase58(signatureBytes);
};

const verify = async (baseUrl, payload) =>
  fetchJson(ensureUrl(baseUrl, "/v1/auth/verify"), {
    method: "POST",
    body: JSON.stringify(payload),
  });

const login = async (baseUrl, keypair, handle) => {
  const wallet = keypair.publicKey.toBase58();
  const challenge = await getChallenge(baseUrl, wallet);
  const signature = signChallenge(keypair, challenge.message);
  const body = {
    wallet,
    nonce: challenge.nonce,
    signature,
  };
  if (handle) {
    body.nebulonId = handle;
  }
  return verify(baseUrl, body);
};

const me = async (baseUrl, token) =>
  fetchJson(ensureUrl(baseUrl, "/v1/auth/me"), {
    method: "GET",
    headers: {
      Authorization: `Bearer ${token}`,
    },
  });

const getContracts = async (baseUrl, token) =>
  fetchJson(ensureUrl(baseUrl, "/v1/contracts"), {
    method: "GET",
    headers: {
      Authorization: `Bearer ${token}`,
    },
  });

const getContract = async (baseUrl, token, id) =>
  fetchJson(ensureUrl(baseUrl, `/v1/contracts/${id}`), {
    method: "GET",
    headers: {
      Authorization: `Bearer ${token}`,
    },
  });

const getContractKeys = async (baseUrl, token, id) =>
  fetchJson(ensureUrl(baseUrl, `/v1/contracts/${id}/keys`), {
    method: "GET",
    headers: {
      Authorization: `Bearer ${token}`,
    },
  });

const updateContract = async (baseUrl, token, id, payload) =>
  fetchJson(ensureUrl(baseUrl, `/v1/contracts/${id}`), {
    method: "PATCH",
    headers: {
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(payload || {}),
  });

const setContractKey = async (baseUrl, token, id, publicKey) =>
  fetchJson(ensureUrl(baseUrl, `/v1/contracts/${id}/keys`), {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ publicKey }),
  });

const lockContract = async (baseUrl, token, id) =>
  fetchJson(ensureUrl(baseUrl, `/v1/contracts/${id}/lock`), {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({}),
  });

const signContract = async (baseUrl, token, id) =>
  fetchJson(ensureUrl(baseUrl, `/v1/contracts/${id}/sign`), {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({}),
  });

const markFunded = async (baseUrl, token, id) =>
  fetchJson(ensureUrl(baseUrl, `/v1/contracts/${id}/mark-funded`), {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({}),
  });

const refreshContract = async (baseUrl, token, id) =>
  fetchJson(ensureUrl(baseUrl, `/v1/contracts/${id}/refresh`), {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({}),
  });

const linkEscrow = async (baseUrl, token, id, payload) =>
  fetchJson(ensureUrl(baseUrl, `/v1/contracts/${id}/link-escrow`), {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(payload || {}),
  });

const rateContract = async (baseUrl, token, id, score) =>
  fetchJson(ensureUrl(baseUrl, `/v1/contracts/${id}/rate`), {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ score }),
  });

const createInvite = async (baseUrl, token, payload) =>
  fetchJson(ensureUrl(baseUrl, "/v1/invites"), {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(payload || {}),
  });

const getInvites = async (baseUrl, token) =>
  fetchJson(ensureUrl(baseUrl, "/v1/invites"), {
    method: "GET",
    headers: {
      Authorization: `Bearer ${token}`,
    },
  });

const acceptInvite = async (baseUrl, token, inviteToken) =>
  fetchJson(ensureUrl(baseUrl, "/v1/invites/accept"), {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ token: inviteToken }),
  });

const acceptInviteById = async (baseUrl, token, payload) =>
  fetchJson(ensureUrl(baseUrl, "/v1/invites/accept-id"), {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(payload || {}),
  });

const declineInvite = async (baseUrl, token, payload) =>
  fetchJson(ensureUrl(baseUrl, "/v1/invites/decline"), {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(payload || {}),
  });

const checkHandle = async (baseUrl, handle) =>
  fetchJson(
    ensureUrl(baseUrl, `/v1/ids/check?handle=${encodeURIComponent(handle)}`)
  );

const updateHandle = async (baseUrl, token, handle, pfp) => {
  const payload = {};
  if (handle) {
    payload.nebulonId = handle;
  }
  if (pfp) {
    payload.pfp = pfp;
  }
  return fetchJson(ensureUrl(baseUrl, "/v1/auth/handle"), {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(payload),
  });
};

const faucet = async (baseUrl, token) =>
  fetchJson(ensureUrl(baseUrl, "/v1/faucet/tusdc"), {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({}),
  });

module.exports = {
  getConfig: (baseUrl) => fetchJson(ensureUrl(baseUrl, "/v1/config")),
  getChallenge,
  signChallenge,
  verify,
  getContracts,
  getContract,
  getContractKeys,
  updateContract,
  setContractKey,
  lockContract,
  signContract,
  markFunded,
  refreshContract,
  linkEscrow,
  rateContract,
  createInvite,
  getInvites,
  acceptInvite,
  acceptInviteById,
  declineInvite,
  checkHandle,
  updateHandle,
  login,
  me,
  faucet,
};

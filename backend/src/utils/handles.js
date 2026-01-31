const HANDLE_REGEX = /^[a-z0-9._-]+$/;

const normalizeHandle = (handle) =>
  (handle || "").trim().toLowerCase().replace(/^@/, "");

const validateHandle = (handle) => {
  const value = normalizeHandle(handle);
  if (!value) {
    return { ok: false, reason: "missing" };
  }
  if (value.length < 4 || value.length > 16) {
    return { ok: false, reason: "length" };
  }
  if (!HANDLE_REGEX.test(value)) {
    return { ok: false, reason: "characters" };
  }
  if (value.startsWith(".") || value.endsWith(".")) {
    return { ok: false, reason: "dots" };
  }
  if (value.includes("..")) {
    return { ok: false, reason: "dots" };
  }
  return { ok: true, value };
};

module.exports = {
  normalizeHandle,
  validateHandle,
};

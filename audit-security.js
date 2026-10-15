const REDACTED = "[REDACTED]";

export function isSensitiveAuditKey(key) {
  const canonical = String(key || "")
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_");
  const parts = canonical.split("_").filter(Boolean);
  return parts.some(part => [
    "password", "passcode", "passphrase", "secret", "token",
    "authorization", "cookie", "apikey"
  ].includes(part)) || canonical.includes("api_key") ||
    canonical.includes("openai_key") || canonical.includes("open_ai_key") ||
    canonical.includes("private_key");
}

function sanitizeAuditString(value) {
  return String(value)
    .replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]+/gi, `$1${REDACTED}`)
    .replace(/([?&](?:greenHook|wahaHook|token|apiToken|apiKey|secret|key|password)=)[^&\s]*/gi, `$1${REDACTED}`);
}

export function sanitizeAuditDetails(value, key = "") {
  if (isSensitiveAuditKey(key)) {
    return value === null || value === undefined || value === "" ? value : REDACTED;
  }
  if (Array.isArray(value)) return value.map(item => sanitizeAuditDetails(item));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([childKey, childValue]) => [
      childKey,
      sanitizeAuditDetails(childValue, childKey)
    ]));
  }
  return typeof value === "string" ? sanitizeAuditString(value) : value;
}

export function systemSettingAuditSummary(value) {
  if (Array.isArray(value)) return { changed: true, valueType: "array", itemCount: value.length };
  if (value && typeof value === "object") {
    return {
      changed: true,
      valueType: "object",
      fields: Object.keys(value).filter(key => !isSensitiveAuditKey(key)).sort()
    };
  }
  return { changed: true, valueType: value === null ? "null" : typeof value };
}

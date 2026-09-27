function isLocalHost(value) {
  return /localhost|127\.0\.0\.1/i.test(value || "");
}

function configuredOrigins() {
  return (process.env.WBC_WEB_ORIGIN || "")
    .split(",")
    .map((origin) => origin.trim().replace(/\/$/, ""))
    .filter(Boolean);
}

function defaultWebOrigin() {
  const configured = configuredOrigins().find((origin) => origin && !isLocalHost(origin));
  if (configured) return configured;
  if (process.env.RENDER === "true" || process.env.NODE_ENV === "production") {
    return "https://www.wbchq.com";
  }
  return "http://localhost:5173";
}

function isAllowedOrigin(origin) {
  if (!origin) return false;
  if (configuredOrigins().includes(origin)) return true;
  if (origin === "https://www.wbchq.com" || origin === "https://wbchq.com") return true;
  if (/^https:\/\/wbc-wrbpage\.onrender\.com$/i.test(origin)) return true;
  if (/^https:\/\/[a-z0-9-]+\.onrender\.com$/i.test(origin)) return true;
  if (/^http:\/\/(localhost|127\.0\.0\.1):\d+$/i.test(origin)) return true;
  return false;
}

function sanitizeOrigin(value) {
  if (typeof value !== "string" || !value.trim()) return "";
  try {
    const origin = new URL(value).origin;
    return isAllowedOrigin(origin) ? origin : "";
  } catch {
    return "";
  }
}

function callbackUri(origin, path) {
  return `${origin}${path}`;
}

function encodeOAuthState(payload) {
  return Buffer.from(JSON.stringify(payload)).toString("base64url");
}

function decodeOAuthState(state) {
  if (typeof state === "string" && state.startsWith("/")) {
    return { returnTo: state, origin: "" };
  }

  try {
    return JSON.parse(Buffer.from(String(state || ""), "base64url").toString());
  } catch {
    return { returnTo: "/", origin: "" };
  }
}

module.exports = {
  callbackUri,
  decodeOAuthState,
  defaultWebOrigin,
  encodeOAuthState,
  sanitizeOrigin,
};

const crypto = require("crypto");

const DEFAULT_TTL_MS = 30 * 24 * 60 * 60 * 1000;

function getSecret() {
  return process.env.SESSION_SECRET || process.env.DISCORD_CLIENT_SECRET || "";
}

function sign(payload, secret) {
  return crypto.createHmac("sha256", secret).update(payload).digest("base64url");
}

function signSessionToken(discordId, ttlMs = DEFAULT_TTL_MS) {
  const secret = getSecret();
  if (!secret || !discordId) return "";

  const payload = Buffer.from(JSON.stringify({
    id: String(discordId),
    exp: Date.now() + ttlMs,
  })).toString("base64url");

  return `${payload}.${sign(payload, secret)}`;
}

function verifySessionToken(token) {
  const secret = getSecret();
  if (!secret || typeof token !== "string") return null;

  const [payload, signature, extra] = token.split(".");
  if (!payload || !signature || extra !== undefined) return null;

  const expected = Buffer.from(sign(payload, secret));
  const received = Buffer.from(signature);
  if (expected.length !== received.length || !crypto.timingSafeEqual(expected, received)) {
    return null;
  }

  try {
    const data = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    if (!data?.id || typeof data.exp !== "number" || data.exp < Date.now()) return null;
    return { discordId: String(data.id) };
  } catch {
    return null;
  }
}

function sessionFromRequest(req) {
  const header = req.headers.authorization || "";
  const match = /^Bearer\s+(.+)$/i.exec(header);
  return match ? verifySessionToken(match[1].trim()) : null;
}

module.exports = { sessionFromRequest, signSessionToken, verifySessionToken };

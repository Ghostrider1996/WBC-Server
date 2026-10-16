const { Router } = require("express");
const {
  exchangeCodeForUser,
  getDiscordAuthorizationUrl,
} = require("../services/discordAuthService");
const { upsertDiscordUser } = require("../services/userService");
const { signSessionToken } = require("../services/sessionToken");
const { resolveChannelNames } = require("../services/discordGuildService");
const {
  callbackUri,
  decodeOAuthState,
  defaultWebOrigin,
  encodeOAuthState,
  sanitizeOrigin,
} = require("../services/webOrigin");

const discordAuthRouter = Router();
const CALLBACK_PATH = "/api/auth/discord/callback";

function resolveWebOrigin(origin) {
  return sanitizeOrigin(origin) || defaultWebOrigin();
}

function isLocalUrl(value) {
  return /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?(\/|$)/i.test(value || "");
}

function resolveRedirectUri(origin) {
  const webOrigin = resolveWebOrigin(origin);
  const configured = (process.env.DISCORD_REDIRECT_URI || "").trim();

  // Local development: use the callback registered with Discord (the server itself),
  // instead of the Vite address, which Discord has no entry for.
  if (isLocalUrl(webOrigin) && isLocalUrl(configured)) {
    return configured;
  }

  return callbackUri(webOrigin, CALLBACK_PATH);
}

function sanitizeReturnTo(value) {
  if (typeof value !== "string" || !value.startsWith("/") || value.startsWith("//")) {
    return "/";
  }

  const [path] = value.split("?");
  if (!/^\/[A-Za-z0-9/_-]*$/.test(path)) {
    return "/";
  }

  return path;
}

function encodeUser(user) {
  return Buffer.from(JSON.stringify({
    id: user.id,
    username: user.username,
    globalName: user.global_name || user.username,
    avatar: user.avatar,
    discriminator: user.discriminator,
    token: signSessionToken(user.id),
  })).toString("base64url");
}

discordAuthRouter.get("/auth/discord", (req, res) => {
  try {
    const returnTo = sanitizeReturnTo(req.query.returnTo);
    const origin = resolveWebOrigin(req.query.origin);
    const redirectUri = resolveRedirectUri(origin);
    const state = encodeOAuthState({ returnTo, origin });
    return res.redirect(getDiscordAuthorizationUrl(state, redirectUri));
  } catch (error) {
    return res.status(500).json({ reason: error.message });
  }
});

discordAuthRouter.get("/auth/discord/callback", async (req, res) => {
  const { code, error, error_description: errorDescription, state } = req.query;
  const decoded = decodeOAuthState(state);
  const returnTo = sanitizeReturnTo(decoded.returnTo);
  const origin = resolveWebOrigin(decoded.origin);
  const redirectUri = resolveRedirectUri(origin);

  if (error || !code) {
    const params = new URLSearchParams({
      discord_error: error || "authorization_failed",
      ...(errorDescription ? { discord_error_description: errorDescription } : {}),
    });
    return res.redirect(`${origin}${returnTo}#${params.toString()}`);
  }

  try {
    const { profile, tokens } = await exchangeCodeForUser(code, redirectUri);

    try {
      await upsertDiscordUser(profile, tokens);
    } catch (databaseError) {
      console.error("Discord user upsert failed:", databaseError.message);
    }

    return res.redirect(`${origin}${returnTo}#discord_user=${encodeUser(profile)}`);
  } catch (authError) {
    const discordError = authError.response?.data?.error || authError.code || "exchange_failed";
    const status = authError.response?.status || authError.statusCode || "unknown_status";
    const description = authError.response?.data?.error_description || authError.message;
    console.error("Discord OAuth callback failed:", status, discordError, description);
    const params = new URLSearchParams({
      discord_error: "login_failed",
      discord_error_description: `${discordError} (${status})`,
    });
    return res.redirect(`${origin}${returnTo}#${params.toString()}`);
  }
});

discordAuthRouter.get("/discord/channels", async (req, res) => {
  const ids = String(req.query.ids || "").split(",");
  try {
    const channels = await resolveChannelNames(ids);
    return res.status(200).json({ channels });
  } catch (error) {
    console.error("Discord channels could not be loaded.", error.response?.status || error.message);
    return res.status(200).json({ channels: {} });
  }
});

module.exports = discordAuthRouter;

const { Router } = require("express");
const {
  exchangeCodeForUser,
  getDiscordAuthorizationUrl,
} = require("../services/discordAuthService");
const { upsertDiscordUser } = require("../services/userService");

const discordAuthRouter = Router();

function isLocalHost(value) {
  return /localhost|127\.0\.0\.1/i.test(value || "");
}

function resolveWebOrigin() {
  const configured = (process.env.WBC_WEB_ORIGIN || "")
    .split(",")
    .map((origin) => origin.trim().replace(/\/$/, ""))
    .find((origin) => origin && !isLocalHost(origin));

  if (configured) {
    return configured;
  }

  if (process.env.RENDER === "true" || process.env.NODE_ENV === "production") {
    return "https://www.wbchq.com";
  }

  return "http://localhost:5173";
}

function resolveRedirectUri(req) {
  const configured = process.env.DISCORD_REDIRECT_URI || "";

  if (configured && !isLocalHost(configured)) {
    return configured;
  }

  const proto = (req.get("x-forwarded-proto") || req.protocol || "https").split(",")[0].trim();
  const host = req.get("host");

  if (host && !isLocalHost(host)) {
    return `${proto}://${host}/api/auth/discord/callback`;
  }

  return configured || "http://localhost:3030/api/auth/discord/callback";
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
  })).toString("base64url");
}

discordAuthRouter.get("/auth/discord", (req, res) => {
  try {
    const returnTo = sanitizeReturnTo(req.query.returnTo);
    const redirectUri = resolveRedirectUri(req);
    return res.redirect(getDiscordAuthorizationUrl(returnTo, redirectUri));
  } catch (error) {
    return res.status(500).json({ reason: error.message });
  }
});

discordAuthRouter.get("/auth/discord/callback", async (req, res) => {
  const { code, error, error_description: errorDescription, state } = req.query;
  const returnTo = sanitizeReturnTo(state);
  const redirectUri = resolveRedirectUri(req);
  const webOrigin = resolveWebOrigin();

  if (error || !code) {
    const params = new URLSearchParams({
      discord_error: error || "authorization_failed",
      ...(errorDescription ? { discord_error_description: errorDescription } : {}),
    });
    return res.redirect(`${webOrigin}${returnTo}#${params.toString()}`);
  }

  try {
    const { profile, tokens } = await exchangeCodeForUser(code, redirectUri);

    try {
      await upsertDiscordUser(profile, tokens);
    } catch (databaseError) {
      console.error("Discord user upsert failed:", databaseError.message);
    }

    return res.redirect(`${webOrigin}${returnTo}#discord_user=${encodeUser(profile)}`);
  } catch (authError) {
    const discordError = authError.response?.data?.error || authError.code || "exchange_failed";
    const status = authError.response?.status || authError.statusCode || "unknown_status";
    const description = authError.response?.data?.error_description || authError.message;
    console.error("Discord OAuth callback failed:", status, discordError, description);
    const params = new URLSearchParams({
      discord_error: "login_failed",
      discord_error_description: `${discordError} (${status})`,
    });
    return res.redirect(`${webOrigin}${returnTo}#${params.toString()}`);
  }
});

module.exports = discordAuthRouter;

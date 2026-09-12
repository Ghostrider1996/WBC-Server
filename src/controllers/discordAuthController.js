const { Router } = require("express");
const {
  exchangeCodeForUser,
  getDiscordAuthorizationUrl,
} = require("../services/discordAuthService");
const { upsertDiscordUser } = require("../services/userService");

const discordAuthRouter = Router();

function getWebOrigin() {
  return process.env.WBC_WEB_ORIGIN || "http://localhost:5173";
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
    return res.redirect(getDiscordAuthorizationUrl(returnTo));
  } catch (error) {
    return res.status(500).json({ reason: error.message });
  }
});

discordAuthRouter.get("/auth/discord/callback", async (req, res) => {
  const { code, error, error_description: errorDescription, state } = req.query;
  const returnTo = sanitizeReturnTo(state);

  if (error || !code) {
    const params = new URLSearchParams({
      discord_error: error || "authorization_failed",
      ...(errorDescription ? { discord_error_description: errorDescription } : {}),
    });
    return res.redirect(`${getWebOrigin()}${returnTo}#${params.toString()}`);
  }

  try {
    const { profile, tokens } = await exchangeCodeForUser(code);
    await upsertDiscordUser(profile, tokens);
    return res.redirect(`${getWebOrigin()}${returnTo}#discord_user=${encodeUser(profile)}`);
  } catch (authError) {
    const discordError = authError.response?.data?.error || "exchange_failed";
    const status = authError.response?.status || "unknown_status";
    const description = authError.response?.data?.error_description || authError.message;
    console.error("Discord OAuth callback failed:", status, discordError, description);
    const params = new URLSearchParams({
      discord_error: "login_failed",
      discord_error_description: `${discordError} (${status})`,
    });
    return res.redirect(`${getWebOrigin()}${returnTo}#${params.toString()}`);
  }
});

module.exports = discordAuthRouter;

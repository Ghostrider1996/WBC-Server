const { Router } = require("express");
const {
  exchangeCodeForUser,
  getDiscordAuthorizationUrl,
} = require("../services/discordAuthService");

const discordAuthRouter = Router();

function getWebOrigin() {
  return process.env.WBC_WEB_ORIGIN || "http://localhost:5173";
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
    return res.redirect(getDiscordAuthorizationUrl());
  } catch (error) {
    return res.status(500).json({ reason: error.message });
  }
});

discordAuthRouter.get("/auth/discord/callback", async (req, res) => {
  const { code, error, error_description: errorDescription } = req.query;

  if (error || !code) {
    const params = new URLSearchParams({
      discord_error: error || "authorization_failed",
      ...(errorDescription ? { discord_error_description: errorDescription } : {}),
    });
    return res.redirect(`${getWebOrigin()}/#${params.toString()}`);
  }

  try {
    const user = await exchangeCodeForUser(code);
    return res.redirect(`${getWebOrigin()}/#discord_user=${encodeUser(user)}`);
  } catch (authError) {
    console.error("Discord OAuth callback failed:", authError.response?.status || authError.message);
    return res.redirect(`${getWebOrigin()}/#discord_error=login_failed`);
  }
});

module.exports = discordAuthRouter;

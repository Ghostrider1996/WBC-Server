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

// discordAuthRouter.get("/auth/discord/callback", async (req, res) => {
//   const { code, error, error_description: errorDescription } = req.query;

//   if (error || !code) {
//     const params = new URLSearchParams({
//       discord_error: error || "authorization_failed",
//       ...(errorDescription ? { discord_error_description: errorDescription } : {}),
//     });
//     return res.redirect(`${getWebOrigin()}/#${params.toString()}`);
//   }

//   try {
//     const user = await exchangeCodeForUser(code);
//     return res.redirect(`${getWebOrigin()}/#discord_user=${encodeUser(user)}`);
//   } catch (authError) {
//     const discordError = authError.response?.data?.error || "exchange_failed";
//     const status = authError.response?.status || "unknown_status";
//     const description = authError.response?.data?.error_description || authError.message;
//     console.error("Discord OAuth callback failed:", status, discordError, description);
//     const params = new URLSearchParams({
//       discord_error: "login_failed",
//       discord_error_description: `${discordError} (${status})`,
//     });
//     return res.redirect(`${getWebOrigin()}/#${params.toString()}`);
//   }
// });

discordAuthRouter.get("/auth/discord/callback", (req, res) => {
    console.log("DISCORD CALLBACK HIT");
    console.log(req.query);

    return res.redirect("https://www.wbchq.com");
});

module.exports = discordAuthRouter;

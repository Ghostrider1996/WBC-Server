const { Router } = require("express");
const {
  getBattleNetAuthorizationUrl,
  exchangeCodeForTokens,
  fetchBattleNetProfile,
  fetchWowCharacters,
  readState,
} = require("../services/blizzardAuthService");
const {
  ensureUserFromDiscord,
  saveBattleNetAccount,
} = require("../services/userService");
const { replaceCharactersForUser } = require("../services/characterService");

const blizzardAuthRouter = Router();

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
  const configured = process.env.BLIZZARD_REDIRECT_URI || "";

  if (configured && !isLocalHost(configured)) {
    return configured;
  }

  const proto = (req.get("x-forwarded-proto") || req.protocol || "https").split(",")[0].trim();
  const host = req.get("host");

  if (host && !isLocalHost(host)) {
    return `${proto}://${host}/api/auth/battlenet/callback`;
  }

  return configured || "http://localhost:3030/api/auth/battlenet/callback";
}

function sanitizeReturnTo(value) {
  if (typeof value !== "string" || !value.startsWith("/") || value.startsWith("//")) {
    return "/profile";
  }

  const [path] = value.split("?");
  if (!/^\/[A-Za-z0-9/_-]*$/.test(path)) {
    return "/profile";
  }

  return path || "/profile";
}

function redirectWith(res, returnTo, params) {
  const query = new URLSearchParams(params);
  return res.redirect(`${resolveWebOrigin()}${returnTo}#${query.toString()}`);
}

blizzardAuthRouter.get("/auth/battlenet", (req, res) => {
  try {
    const discordId = String(req.query.discordId || "").trim();

    if (!discordId) {
      return res.status(400).json({ reason: "Sign in with Discord before connecting Battle.net." });
    }

    const authorizationUrl = getBattleNetAuthorizationUrl({
      discordId,
      username: String(req.query.username || "").slice(0, 32),
      globalName: String(req.query.globalName || "").slice(0, 64),
      returnTo: sanitizeReturnTo(req.query.returnTo),
    }, resolveRedirectUri(req));

    return res.redirect(authorizationUrl);
  } catch (error) {
    return res.status(500).json({ reason: error.message });
  }
});

blizzardAuthRouter.get("/auth/battlenet/callback", async (req, res) => {
  const { code, error, error_description: errorDescription, state } = req.query;
  let returnTo = "/profile";

  try {
    if (state) {
      returnTo = sanitizeReturnTo(readState(state).returnTo);
    }
  } catch {
    return redirectWith(res, "/profile", {
      battlenet_error: "login_failed",
      battlenet_error_description: "invalid_state",
    });
  }

  if (error || !code) {
    return redirectWith(res, returnTo, {
      battlenet_error: error || "authorization_failed",
      ...(errorDescription ? { battlenet_error_description: errorDescription } : {}),
    });
  }

  try {
    const payload = readState(state);
    returnTo = sanitizeReturnTo(payload.returnTo);

    const tokens = await exchangeCodeForTokens(code, resolveRedirectUri(req));
    const profile = await fetchBattleNetProfile(tokens.access_token);
    const user = await ensureUserFromDiscord({
      discordId: payload.discordId,
      username: payload.username,
      globalName: payload.globalName,
    });

    await saveBattleNetAccount(user.id, profile, tokens);

    try {
      const characters = await fetchWowCharacters(tokens.access_token);
      await replaceCharactersForUser(user.id, characters);
    } catch (syncError) {
      console.error("Battle.net character sync failed:", syncError.message);
    }

    return redirectWith(res, returnTo, { battlenet: "connected" });
  } catch (authError) {
    const blizzardError = authError.response?.data?.error || authError.code || "exchange_failed";
    const status = authError.response?.status || "unknown_status";
    console.error("Battle.net OAuth callback failed:", status, blizzardError, authError.message);
    return redirectWith(res, returnTo, {
      battlenet_error: "login_failed",
      battlenet_error_description: `${blizzardError} (${status})`,
    });
  }
});

module.exports = blizzardAuthRouter;

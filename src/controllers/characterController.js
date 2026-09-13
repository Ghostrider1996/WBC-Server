const { Router } = require("express");
const {
  findUserByDiscordId,
  saveBattleNetAccount,
  disconnectBattleNet,
  setWarcraftLogsEnabled,
} = require("../services/userService");
const {
  listCharactersForUser,
  replaceCharactersForUser,
  updateCharacterWarcraftLogsUrl,
  deleteCharactersForUser,
} = require("../services/characterService");
const {
  refreshBattleNetTokens,
  fetchWowCharacters,
} = require("../services/blizzardAuthService");
const {
  attachWarcraftLogs,
  summarizeLogs,
  clearLogsCache,
} = require("../services/warcraftLogsService");

const characterRouter = Router();

function expired(expiresAt) {
  if (!expiresAt) {
    return true;
  }

  return new Date(expiresAt).getTime() <= Date.now() + 60 * 1000;
}

function requireDiscordId(req, res) {
  const discordId = String(req.body?.discordId || req.query.discordId || "").trim();

  if (!discordId) {
    res.status(400).json({ reason: "A Discord account is required.", status: "failed" });
    return null;
  }

  return discordId;
}

async function getAccessToken(user) {
  if (user.battlenet_access_token && !expired(user.battlenet_token_expires_at)) {
    return user.battlenet_access_token;
  }

  if (!user.battlenet_refresh_token) {
    throw Object.assign(new Error("Battle.net is not connected."), { statusCode: 401 });
  }

  const tokens = await refreshBattleNetTokens(user.battlenet_refresh_token);
  await saveBattleNetAccount(user.id, {
    id: user.battlenet_id,
    battletag: user.battlenet_battletag,
  }, tokens);

  return tokens.access_token;
}

async function saveLogUrls(characters) {
  await Promise.all(characters.map((character) => (
    character.warcraftlogsUrl
      ? updateCharacterWarcraftLogsUrl(character.id, character.warcraftlogsUrl)
      : Promise.resolve()
  )));
}

async function buildProfile(user, { refreshLogs = false } = {}) {
  const logsEnabled = user.warcraftlogs_enabled !== false;
  let characters = await listCharactersForUser(user.id);

  if (refreshLogs) {
    clearLogsCache();
  }

  if (logsEnabled && characters.length) {
    characters = await attachWarcraftLogs(characters);
    await saveLogUrls(characters);
  }

  return {
    connected: Boolean(user.battlenet_id),
    battletag: user.battlenet_battletag || null,
    warcraftlogsEnabled: logsEnabled,
    characters,
    logs: logsEnabled ? summarizeLogs(characters) : {},
  };
}

characterRouter.get("/characters", async (req, res) => {
  const discordId = requireDiscordId(req, res);
  if (!discordId) return;

  try {
    const user = await findUserByDiscordId(discordId);

    if (!user) {
      return res.status(200).json({
        connected: false,
        battletag: null,
        warcraftlogsEnabled: true,
        characters: [],
        logs: {},
      });
    }

    return res.status(200).json(await buildProfile(user));
  } catch (error) {
    console.error("List characters failed:", error.message);
    return res.status(500).json({ reason: "Characters could not be loaded.", status: "failed" });
  }
});

characterRouter.post("/characters/sync", async (req, res) => {
  const discordId = requireDiscordId(req, res);
  if (!discordId) return;

  try {
    const user = await findUserByDiscordId(discordId);

    if (!user?.battlenet_id) {
      return res.status(401).json({ reason: "Connect Battle.net first.", status: "failed" });
    }

    const accessToken = await getAccessToken(user);
    const characters = await fetchWowCharacters(accessToken);
    await replaceCharactersForUser(user.id, characters);
    const latest = await findUserByDiscordId(discordId);

    return res.status(200).json(await buildProfile(latest, { refreshLogs: true }));
  } catch (error) {
    console.error("Sync characters failed:", error.message);
    return res.status(error.statusCode || 500).json({
      reason: error.statusCode === 401 ? error.message : "Characters could not be refreshed.",
      status: "failed",
    });
  }
});

characterRouter.post("/characters/disconnect", async (req, res) => {
  const discordId = requireDiscordId(req, res);
  if (!discordId) return;

  try {
    const user = await findUserByDiscordId(discordId);

    if (!user) {
      return res.status(200).json({
        connected: false,
        battletag: null,
        warcraftlogsEnabled: true,
        characters: [],
        logs: {},
      });
    }

    await disconnectBattleNet(user.id);
    await deleteCharactersForUser(user.id);
    clearLogsCache();

    return res.status(200).json({
      connected: false,
      battletag: null,
      warcraftlogsEnabled: user.warcraftlogs_enabled !== false,
      characters: [],
      logs: {},
    });
  } catch (error) {
    console.error("Disconnect Battle.net failed:", error.message);
    return res.status(500).json({ reason: "Battle.net could not be disconnected.", status: "failed" });
  }
});

characterRouter.post("/characters/logs/sync", async (req, res) => {
  const discordId = requireDiscordId(req, res);
  if (!discordId) return;

  try {
    const user = await findUserByDiscordId(discordId);

    if (!user?.battlenet_id) {
      return res.status(401).json({ reason: "Connect Battle.net first.", status: "failed" });
    }

    await setWarcraftLogsEnabled(user.id, true);
    const latest = await findUserByDiscordId(discordId);
    return res.status(200).json(await buildProfile(latest, { refreshLogs: true }));
  } catch (error) {
    console.error("Sync Warcraft Logs failed:", error.message);
    return res.status(500).json({ reason: "Warcraft Logs could not be refreshed.", status: "failed" });
  }
});

characterRouter.post("/characters/logs/disconnect", async (req, res) => {
  const discordId = requireDiscordId(req, res);
  if (!discordId) return;

  try {
    const user = await findUserByDiscordId(discordId);

    if (!user) {
      return res.status(200).json({
        connected: false,
        battletag: null,
        warcraftlogsEnabled: false,
        characters: [],
        logs: {},
      });
    }

    await setWarcraftLogsEnabled(user.id, false);
    const latest = await findUserByDiscordId(discordId);
    return res.status(200).json(await buildProfile(latest));
  } catch (error) {
    console.error("Disconnect Warcraft Logs failed:", error.message);
    return res.status(500).json({ reason: "Warcraft Logs could not be disconnected.", status: "failed" });
  }
});

module.exports = characterRouter;

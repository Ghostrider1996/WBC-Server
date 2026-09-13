const { query } = require("../db/pool");

async function upsertDiscordUser(profile, tokens = {}) {
  const discordId = String(profile.id);
  const username = profile.username;
  const globalName = profile.global_name || profile.username;
  const discriminator = profile.discriminator || "0";
  const avatar = profile.avatar || null;
  const accessToken = tokens.access_token || null;
  const refreshToken = tokens.refresh_token || null;
  const expiresAt = tokens.expires_in
    ? new Date(Date.now() + Number(tokens.expires_in) * 1000)
    : null;

  const result = await query(
    `
      INSERT INTO users (
        discord_id,
        username,
        global_name,
        discriminator,
        avatar,
        discord_access_token,
        discord_refresh_token,
        token_expires_at,
        token_refreshed_at,
        token_refresh_label
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, now(), 'initial')
      ON CONFLICT (discord_id) DO UPDATE SET
        username = EXCLUDED.username,
        global_name = EXCLUDED.global_name,
        discriminator = EXCLUDED.discriminator,
        avatar = EXCLUDED.avatar,
        discord_access_token = EXCLUDED.discord_access_token,
        discord_refresh_token = COALESCE(EXCLUDED.discord_refresh_token, users.discord_refresh_token),
        token_expires_at = EXCLUDED.token_expires_at,
        token_refreshed_at = now(),
        token_refresh_label = 'login'
      RETURNING id, discord_id, username, global_name, created_at
    `,
    [discordId, username, globalName, discriminator, avatar, accessToken, refreshToken, expiresAt],
  );

  return result.rows[0];
}

async function findUserByDiscordId(discordId) {
  const result = await query(
    `
      SELECT
        id,
        discord_id,
        username,
        battlenet_id,
        battlenet_battletag,
        battlenet_access_token,
        battlenet_refresh_token,
        battlenet_token_expires_at,
        battlenet_connected_at,
        COALESCE(warcraftlogs_enabled, true) AS warcraftlogs_enabled
      FROM users
      WHERE discord_id = $1
    `,
    [String(discordId)],
  );

  return result.rows[0] || null;
}

async function ensureUserFromDiscord({ discordId, username, globalName }) {
  const existing = await findUserByDiscordId(discordId);

  if (existing) {
    return existing;
  }

  const result = await query(
    `
      INSERT INTO users (discord_id, username, global_name)
      VALUES ($1, $2, $3)
      ON CONFLICT (discord_id) DO UPDATE SET
        username = EXCLUDED.username,
        global_name = COALESCE(EXCLUDED.global_name, users.global_name)
      RETURNING
        id,
        discord_id,
        username,
        battlenet_id,
        battlenet_battletag,
        battlenet_access_token,
        battlenet_refresh_token,
        battlenet_token_expires_at,
        battlenet_connected_at,
        COALESCE(warcraftlogs_enabled, true) AS warcraftlogs_enabled
    `,
    [String(discordId), username || "unknown", globalName || username || "unknown"],
  );

  return result.rows[0];
}

async function saveBattleNetAccount(userId, profile, tokens = {}) {
  const expiresAt = tokens.expires_in
    ? new Date(Date.now() + Number(tokens.expires_in) * 1000)
    : null;

  const result = await query(
    `
      UPDATE users SET
        battlenet_id = $2,
        battlenet_battletag = $3,
        battlenet_access_token = $4,
        battlenet_refresh_token = COALESCE($5, battlenet_refresh_token),
        battlenet_token_expires_at = $6,
        battlenet_connected_at = now()
      WHERE id = $1
      RETURNING
        id,
        discord_id,
        battlenet_id,
        battlenet_battletag,
        battlenet_connected_at
    `,
    [
      userId,
      profile.id,
      profile.battletag,
      tokens.access_token || null,
      tokens.refresh_token || null,
      expiresAt,
    ],
  );

  return result.rows[0];
}

async function disconnectBattleNet(userId) {
  await query(
    `
      UPDATE users SET
        battlenet_id = NULL,
        battlenet_battletag = NULL,
        battlenet_access_token = NULL,
        battlenet_refresh_token = NULL,
        battlenet_token_expires_at = NULL,
        battlenet_connected_at = NULL
      WHERE id = $1
    `,
    [userId],
  );
}

async function setWarcraftLogsEnabled(userId, enabled) {
  const result = await query(
    `
      UPDATE users
      SET warcraftlogs_enabled = $2
      WHERE id = $1
      RETURNING COALESCE(warcraftlogs_enabled, true) AS warcraftlogs_enabled
    `,
    [userId, Boolean(enabled)],
  );

  return result.rows[0]?.warcraftlogs_enabled !== false;
}

module.exports = {
  upsertDiscordUser,
  findUserByDiscordId,
  ensureUserFromDiscord,
  saveBattleNetAccount,
  disconnectBattleNet,
  setWarcraftLogsEnabled,
};

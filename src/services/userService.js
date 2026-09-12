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

module.exports = { upsertDiscordUser };

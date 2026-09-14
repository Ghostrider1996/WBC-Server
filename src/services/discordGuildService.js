const axios = require("axios");
const { query } = require("../db/pool");
const { isAdmin } = require("./adminService");

const GM_ROLE_NAMES = new Set(["gm", "guild master", "guildmaster"]);
const roleCache = new Map();
const ROLE_CACHE_MS = 60 * 1000;

function cleanEnvValue(value) {
  if (!value || typeof value !== "string") return "";
  return value.split("#")[0].trim();
}

function getGuildId() {
  return cleanEnvValue(process.env.DISCORD_GUILD_ID || process.env.RAID_HELPER_SERVER_ID);
}

function getConfiguredGmRoleIds() {
  const raw = cleanEnvValue(process.env.DISCORD_GM_ROLE_ID || process.env.DISCORD_GM_ROLE_IDS);
  return new Set(raw.split(",").map((value) => value.trim()).filter(Boolean));
}

function getBotToken() {
  return cleanEnvValue(process.env.DISCORD_BOT_TOKEN);
}

async function getStoredDiscordToken(discordId) {
  const result = await query(
    `SELECT discord_access_token FROM users WHERE discord_id = $1`,
    [String(discordId)],
  );
  return result.rows[0]?.discord_access_token || null;
}

async function fetchGuildRoles(guildId) {
  const botToken = getBotToken();
  if (!botToken) return [];

  const response = await axios.get(`https://discord.com/api/v10/guilds/${guildId}/roles`, {
    headers: { Authorization: `Bot ${botToken}` },
  });
  return Array.isArray(response.data) ? response.data : [];
}

async function resolveGmRoleIds(guildId) {
  const configured = getConfiguredGmRoleIds();
  if (configured.size) return configured;

  const roles = await fetchGuildRoles(guildId);
  return new Set(
    roles
      .filter((role) => GM_ROLE_NAMES.has(String(role.name || "").trim().toLowerCase()))
      .map((role) => String(role.id)),
  );
}

async function fetchMemberRoleIds(discordId, guildId) {
  const botToken = getBotToken();

  if (botToken) {
    const response = await axios.get(
      `https://discord.com/api/v10/guilds/${guildId}/members/${discordId}`,
      { headers: { Authorization: `Bot ${botToken}` } },
    );
    return Array.isArray(response.data?.roles) ? response.data.roles.map(String) : [];
  }

  const accessToken = await getStoredDiscordToken(discordId);
  if (!accessToken) return [];

  const response = await axios.get(
    `https://discord.com/api/v10/users/@me/guilds/${guildId}/member`,
    { headers: { Authorization: `Bearer ${accessToken}` } },
  );
  return Array.isArray(response.data?.roles) ? response.data.roles.map(String) : [];
}

async function memberHasGmRole(discordId) {
  const guildId = getGuildId();
  if (!discordId || !guildId) return false;

  try {
    const gmRoleIds = await resolveGmRoleIds(guildId);
    if (!gmRoleIds.size) return false;
    const memberRoles = await fetchMemberRoleIds(discordId, guildId);
    return memberRoles.some((roleId) => gmRoleIds.has(roleId));
  } catch (error) {
    if (error.response?.status === 404) return false;
    console.error("Discord GM role check failed:", error.response?.status || error.message);
    return false;
  }
}

async function canManageRaidEvents(actor = {}) {
  const discordId = String(actor.discordId || actor.id || "").trim();
  const cacheKey = discordId || `${actor.username || ""}:${actor.globalName || ""}`;
  const cached = roleCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.value;
  }

  const allowed = isAdmin(actor) || await memberHasGmRole(discordId);
  roleCache.set(cacheKey, { value: allowed, expiresAt: Date.now() + ROLE_CACHE_MS });
  return allowed;
}

module.exports = { canManageRaidEvents, memberHasGmRole };

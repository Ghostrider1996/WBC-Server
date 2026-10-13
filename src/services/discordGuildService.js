const axios = require("axios");
const { query } = require("../db/pool");
const { isAdmin } = require("./adminService");

const GM_ROLE_NAMES = new Set(["gm", "guild master", "guildmaster"]);
const KNOWN_DISCORD_CHANNELS = {
  "1411724073406431403": "announcements",
};

const roleCache = new Map();
const ROLE_CACHE_MS = 60 * 1000;
const CHANNEL_CACHE_MS = 10 * 60 * 1000;
let guildChannelCache = { expiresAt: 0, byId: null };

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

  const allowed = await isAdmin(actor) || await memberHasGmRole(discordId);
  roleCache.set(cacheKey, { value: allowed, expiresAt: Date.now() + ROLE_CACHE_MS });
  return allowed;
}

async function loadGuildChannelMap() {
  if (guildChannelCache.byId && guildChannelCache.expiresAt > Date.now()) {
    return guildChannelCache.byId;
  }

  const botToken = getBotToken();
  const guildId = getGuildId();
  if (!botToken || !guildId) {
    guildChannelCache = { expiresAt: Date.now() + 60 * 1000, byId: new Map() };
    return guildChannelCache.byId;
  }

  const response = await axios.get(`https://discord.com/api/v10/guilds/${guildId}/channels`, {
    headers: { Authorization: `Bot ${botToken}` },
  });
  const byId = new Map();
  for (const channel of Array.isArray(response.data) ? response.data : []) {
    if (channel?.id && channel?.name) byId.set(String(channel.id), channel.name);
  }

  guildChannelCache = { expiresAt: Date.now() + CHANNEL_CACHE_MS, byId };
  return byId;
}

async function resolveChannelNames(ids) {
  const wanted = [...new Set((ids || []).map((id) => String(id).trim()))]
    .filter((id) => /^\d{17,20}$/.test(id))
    .slice(0, 30);
  if (!wanted.length) return {};

  const byId = await loadGuildChannelMap();
  return Object.fromEntries(
    wanted
      .filter((id) => byId.has(id) || KNOWN_DISCORD_CHANNELS[id])
      .map((id) => [id, byId.get(id) || KNOWN_DISCORD_CHANNELS[id]]),
  );
}

module.exports = { canManageRaidEvents, memberHasGmRole, resolveChannelNames };

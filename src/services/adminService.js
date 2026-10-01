const crypto = require("crypto");
const { query } = require("../db/pool");

const OWNER_DISCORD_ID = cleanEnvValue(process.env.ADMIN_OWNER_DISCORD_ID) || "315040446370021378";
const DISCORD_SNOWFLAKE = /^\d{17,20}$/;

function cleanEnvValue(value) {
  if (!value || typeof value !== "string") {
    return "";
  }

  return value.split("#")[0].trim();
}

function getAdminUsernames() {
  const raw = [
    process.env.ADMIN_USERNAME,
    process.env.VITE_ADMIN_USERNAME,
    "madrebelftw",
  ]
    .map(cleanEnvValue)
    .filter(Boolean)
    .join(",");

  return [...new Set(
    raw.split(",").map((value) => value.trim().toLowerCase()).filter(Boolean),
  )];
}

function getAdminDiscordIds() {
  const raw = cleanEnvValue(process.env.ADMIN_DISCORD_ID || process.env.ADMIN_DISCORD_IDS);

  return new Set(
    raw.split(",").map((value) => value.trim()).filter(Boolean),
  );
}

function actorDiscordId(actor = {}) {
  if (typeof actor === "string") return "";
  return String(actor.discordId || actor.id || "").trim();
}

function isOwnerDiscordId(discordId) {
  return Boolean(discordId) && String(discordId) === OWNER_DISCORD_ID;
}

function isOwner(actor = {}) {
  return isOwnerDiscordId(actorDiscordId(actor));
}

function isEnvAdmin(actor = {}) {
  const username = typeof actor === "string" ? actor : actor.username;
  const globalName = typeof actor === "string" ? "" : actor.globalName || actor.global_name;
  const discordId = actorDiscordId(actor);
  const names = [username, globalName]
    .filter((value) => typeof value === "string" && value.trim())
    .map((value) => value.trim().toLowerCase());

  if (isOwnerDiscordId(discordId)) {
    return true;
  }

  if (discordId && getAdminDiscordIds().has(discordId)) {
    return true;
  }

  return names.some((name) => getAdminUsernames().includes(name));
}

async function isListedAdmin(discordId) {
  if (!discordId) return false;

  const result = await query(
    "SELECT 1 FROM guild_admins WHERE discord_id = $1 LIMIT 1",
    [discordId],
  );

  return result.rowCount > 0;
}

async function isAdmin(actor = {}) {
  if (isEnvAdmin(actor)) {
    return true;
  }

  return isListedAdmin(actorDiscordId(actor));
}

function ownerPasswordMatches(password) {
  const expected = process.env.ADMIN_OWNER_PASSWORD || "";
  if (!expected) return false;

  const submitted = typeof password === "string" ? password : "";
  const submittedBuffer = Buffer.from(submitted, "utf8");
  const expectedBuffer = Buffer.from(expected, "utf8");

  if (submittedBuffer.length !== expectedBuffer.length) {
    crypto.timingSafeEqual(expectedBuffer, expectedBuffer);
    return false;
  }

  return crypto.timingSafeEqual(submittedBuffer, expectedBuffer);
}

async function listGuildAdmins() {
  const result = await query(`
    SELECT
      ga.discord_id AS "discordId",
      ga.role,
      ga.created_at AS "createdAt",
      u.username,
      u.global_name AS "globalName"
    FROM guild_admins ga
    LEFT JOIN users u ON u.discord_id = ga.discord_id
    ORDER BY CASE WHEN ga.role = 'owner' THEN 0 ELSE 1 END, ga.created_at ASC
  `);

  return result.rows;
}

async function getAdminStatus(actor = {}) {
  const discordId = actorDiscordId(actor);

  return {
    isAdmin: await isAdmin(actor),
    canManageAdmins: isOwnerDiscordId(discordId),
  };
}

async function addGuildAdmin({ actor, password, adminDiscordId }) {
  const actorId = actorDiscordId(actor);

  if (!isOwnerDiscordId(actorId)) {
    const error = new Error("Only the guild owner can add admins.");
    error.statusCode = 403;
    throw error;
  }

  if (!cleanEnvValue(process.env.ADMIN_OWNER_PASSWORD)) {
    const error = new Error("Admin password is not configured on the server.");
    error.statusCode = 503;
    throw error;
  }

  if (!ownerPasswordMatches(password)) {
    const error = new Error("The password is incorrect.");
    error.statusCode = 401;
    throw error;
  }

  const discordId = String(adminDiscordId || "").trim();
  if (!DISCORD_SNOWFLAKE.test(discordId)) {
    const error = new Error("A valid Discord account ID is required.");
    error.statusCode = 400;
    throw error;
  }

  if (isOwnerDiscordId(discordId)) {
    const error = new Error("That account is already the guild owner.");
    error.statusCode = 409;
    throw error;
  }

  try {
    await query(
      `INSERT INTO guild_admins (discord_id, role, added_by_discord_id)
       VALUES ($1, 'admin', $2)`,
      [discordId, actorId],
    );
  } catch (error) {
    if (error.code === "23505") {
      const conflict = new Error("That Discord account is already an admin.");
      conflict.statusCode = 409;
      throw conflict;
    }

    throw error;
  }

  return listGuildAdmins();
}

module.exports = {
  OWNER_DISCORD_ID,
  addGuildAdmin,
  getAdminStatus,
  isAdmin,
  isOwner,
  listGuildAdmins,
};

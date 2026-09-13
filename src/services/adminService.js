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

function isAdmin(actor = {}) {
  const username = typeof actor === "string" ? actor : actor.username;
  const globalName = typeof actor === "string" ? "" : actor.globalName || actor.global_name;
  const discordId = typeof actor === "string" ? "" : String(actor.discordId || actor.id || "");
  const names = [username, globalName]
    .filter((value) => typeof value === "string" && value.trim())
    .map((value) => value.trim().toLowerCase());

  if (discordId && getAdminDiscordIds().has(discordId)) {
    return true;
  }

  return names.some((name) => getAdminUsernames().includes(name));
}

module.exports = { isAdmin };

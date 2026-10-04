const crypto = require("crypto");
const { getPool } = require("../db/pool");

function cleanEnvValue(value) {
  if (!value || typeof value !== "string") return "";
  return value.split("#")[0].trim();
}

function getBridgeToken() {
  return cleanEnvValue(process.env.BRIDGE_API_TOKEN);
}

function tokensMatch(submitted, expected) {
  if (!expected) return false;

  const submittedBuffer = Buffer.from(String(submitted || ""), "utf8");
  const expectedBuffer = Buffer.from(expected, "utf8");

  if (submittedBuffer.length !== expectedBuffer.length) {
    crypto.timingSafeEqual(expectedBuffer, expectedBuffer);
    return false;
  }

  return crypto.timingSafeEqual(submittedBuffer, expectedBuffer);
}

function readBearerToken(req) {
  const header = String(req.headers.authorization || "");
  const match = header.match(/^Bearer\s+(\S+)/i);
  return match ? match[1].trim() : "";
}

function authorizeBridge(req) {
  const expected = getBridgeToken();
  if (!expected) {
    const error = new Error("Bridge token is not configured on the server.");
    error.statusCode = 503;
    throw error;
  }

  if (!tokensMatch(readBearerToken(req), expected)) {
    const error = new Error("Unauthorized.");
    error.statusCode = 401;
    throw error;
  }
}

function asTrimmedString(value) {
  return typeof value === "string" ? value.trim() : "";
}

function asInteger(value) {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? Math.trunc(n) : null;
}

function asBoolean(value) {
  if (typeof value === "boolean") return value;
  if (value === 1 || value === "1" || value === "true") return true;
  return false;
}

function fromUnixSeconds(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  return new Date(n * 1000);
}

async function withTransaction(fn) {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch {
      // The original error matters more than rollback failure.
    }
    throw error;
  } finally {
    client.release();
  }
}

async function upsertRosterMembers(client, members) {
  for (const member of members) {
    const characterName = asTrimmedString(member?.name);
    if (!characterName) continue;

    await client.query(
      `INSERT INTO guild_roster_members (
        character_name, rank_index, rank_name, level, class, public_note, officer_note,
        online, last_online_days, last_online_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
      ON CONFLICT (lower(character_name)) DO UPDATE SET
        character_name = EXCLUDED.character_name,
        rank_index = EXCLUDED.rank_index,
        rank_name = EXCLUDED.rank_name,
        level = EXCLUDED.level,
        class = EXCLUDED.class,
        public_note = EXCLUDED.public_note,
        officer_note = EXCLUDED.officer_note,
        online = EXCLUDED.online,
        last_online_days = EXCLUDED.last_online_days,
        last_online_at = EXCLUDED.last_online_at`,
      [
        characterName,
        asInteger(member.rankIndex),
        asTrimmedString(member.rankName) || null,
        asInteger(member.level),
        asTrimmedString(member.class) || null,
        asTrimmedString(member.publicNote),
        asTrimmedString(member.officerNote),
        asBoolean(member.online),
        asInteger(member.lastOnlineDays),
        asInteger(member.lastOnlineAt),
      ],
    );
  }
}

async function upsertProfessions(client, professions) {
  for (const profession of professions) {
    const characterName = asTrimmedString(profession?.characterName);
    const skillLineId = asInteger(profession?.skillLineID ?? profession?.skillLineId);
    const name = asTrimmedString(profession?.name);
    if (!characterName || skillLineId == null || !name) continue;

    await client.query(
      `INSERT INTO guild_professions (
        character_name, name, skill_line_id, current_skill, max_skill
      ) VALUES ($1, $2, $3, $4, $5)
      ON CONFLICT (lower(character_name), skill_line_id) DO UPDATE SET
        character_name = EXCLUDED.character_name,
        name = EXCLUDED.name,
        current_skill = EXCLUDED.current_skill,
        max_skill = EXCLUDED.max_skill`,
      [
        characterName,
        name,
        skillLineId,
        asInteger(profession.currentSkill),
        asInteger(profession.maxSkill),
      ],
    );

    if (!Array.isArray(profession.recipes) || profession.recipes.length === 0) continue;

    for (const recipe of profession.recipes) {
      const recipeId = asInteger(recipe?.recipeID ?? recipe?.recipeId);
      if (recipeId == null) continue;

      await client.query(
        `INSERT INTO guild_profession_recipes (
          character_name, skill_line_id, recipe_id, recipe_name, learned
        ) VALUES ($1, $2, $3, $4, $5)
        ON CONFLICT (lower(character_name), skill_line_id, recipe_id) DO UPDATE SET
          character_name = EXCLUDED.character_name,
          recipe_name = EXCLUDED.recipe_name,
          learned = EXCLUDED.learned`,
        [
          asTrimmedString(recipe.characterName) || characterName,
          skillLineId,
          recipeId,
          asTrimmedString(recipe.recipeName) || null,
          recipe.learned === false ? false : true,
        ],
      );
    }
  }
}

async function dropProfessions(client, drops) {
  for (const drop of drops) {
    const characterName = asTrimmedString(drop?.characterName || drop?.character);
    const skillLineId = asInteger(drop?.skillLineID ?? drop?.skillLineId);
    const name = asTrimmedString(drop?.name || drop?.profession);
    if (!characterName || (skillLineId == null && !name)) continue;

    if (skillLineId != null) {
      await client.query(
        `DELETE FROM guild_profession_recipes
         WHERE lower(character_name) = lower($1) AND skill_line_id = $2`,
        [characterName, skillLineId],
      );
      await client.query(
        `DELETE FROM guild_professions
         WHERE lower(character_name) = lower($1) AND skill_line_id = $2`,
        [characterName, skillLineId],
      );
      continue;
    }

    await client.query(
      `DELETE FROM guild_profession_recipes
       WHERE lower(character_name) = lower($1)
         AND skill_line_id IN (
           SELECT skill_line_id FROM guild_professions
           WHERE lower(character_name) = lower($1) AND lower(name) = lower($2)
         )`,
      [characterName, name],
    );
    await client.query(
      `DELETE FROM guild_professions
       WHERE lower(character_name) = lower($1) AND lower(name) = lower($2)`,
      [characterName, name],
    );
  }
}

async function ingestBridgeUpload(payload = {}) {
  const roster = Array.isArray(payload.roster) ? payload.roster : [];
  const professions = Array.isArray(payload.professions) ? payload.professions : [];
  const professionDrops = Array.isArray(payload.professionDrops) ? payload.professionDrops : [];
  const rosterUpdatedAt = fromUnixSeconds(payload.rosterUpdatedAt);

  await withTransaction(async (client) => {
    if (rosterUpdatedAt) {
      await client.query(
        `INSERT INTO guild_roster_meta (id, roster_updated_at, updated_at)
         VALUES (1, $1, now())
         ON CONFLICT (id) DO UPDATE SET
           roster_updated_at = EXCLUDED.roster_updated_at,
           updated_at = now()`,
        [rosterUpdatedAt],
      );
    }

    if (roster.length > 0) {
      await upsertRosterMembers(client, roster);
    }

    if (professions.length > 0) {
      await upsertProfessions(client, professions);
    }

    if (professionDrops.length > 0) {
      await dropProfessions(client, professionDrops);
    }
  });
}

function presentMember(row) {
  return {
    name: row.character_name,
    rankIndex: row.rank_index,
    rankName: row.rank_name || "",
    level: row.level,
    class: row.class || "",
    publicNote: row.public_note || "",
    online: Boolean(row.online),
    lastOnlineDays: row.last_online_days,
  };
}

function presentProfession(row, recipes) {
  return {
    characterName: row.character_name,
    name: row.name,
    skillLineID: row.skill_line_id,
    currentSkill: row.current_skill,
    maxSkill: row.max_skill,
    recipes: recipes.map((recipe) => ({
      recipeID: recipe.recipe_id,
      recipeName: recipe.recipe_name || "",
      learned: recipe.learned !== false,
    })),
  };
}

async function listGuildRoster() {
  const client = await getPool().connect();
  try {
    const [meta, members, professions, recipes] = await Promise.all([
      client.query("SELECT roster_updated_at AS \"rosterUpdatedAt\" FROM guild_roster_meta WHERE id = 1"),
      client.query(`
        SELECT character_name, rank_index, rank_name, level, class, public_note, online, last_online_days
        FROM guild_roster_members
        ORDER BY rank_index ASC NULLS LAST, lower(character_name) ASC
      `),
      client.query(`
        SELECT character_name, name, skill_line_id, current_skill, max_skill
        FROM guild_professions
        ORDER BY lower(character_name) ASC, lower(name) ASC
      `),
      client.query(`
        SELECT character_name, skill_line_id, recipe_id, recipe_name, learned
        FROM guild_profession_recipes
        ORDER BY lower(recipe_name) ASC, recipe_id ASC
      `),
    ]);

    const recipesByKey = new Map();
    for (const recipe of recipes.rows) {
      const key = `${recipe.character_name.toLowerCase()}:${recipe.skill_line_id}`;
      const list = recipesByKey.get(key) || [];
      list.push(recipe);
      recipesByKey.set(key, list);
    }

    return {
      rosterUpdatedAt: meta.rows[0]?.rosterUpdatedAt || null,
      members: members.rows.map(presentMember),
      professions: professions.rows.map((row) => (
        presentProfession(row, recipesByKey.get(`${row.character_name.toLowerCase()}:${row.skill_line_id}`) || [])
      )),
    };
  } finally {
    client.release();
  }
}

module.exports = {
  authorizeBridge,
  ingestBridgeUpload,
  listGuildRoster,
};

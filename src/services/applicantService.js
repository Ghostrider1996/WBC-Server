const { getPool, query } = require("../db/pool");

const DISCORD_SNOWFLAKE = /^\d{17,20}$/;

function fail(message, statusCode) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function cleanMainCharacterName(value) {
  const name = String(value ?? "").replace(/\s+/g, " ").trim();
  if (!name) return "";
  if (name.length > 25 || !/^[\p{L}][\p{L}'’.-]*(?: [\p{L}][\p{L}'’.-]*)?$/u.test(name)) {
    throw fail("Enter a character name like Madrebel Bulwark, or leave it blank.", 400);
  }
  return name;
}

function cleanDiscordId(value) {
  const discordId = String(value || "").replace(/\D/g, "");
  return DISCORD_SNOWFLAKE.test(discordId) ? discordId : "";
}

async function rememberApplicant(applicant) {
  const discordId = cleanDiscordId(applicant?.discordId || applicant?.id);
  if (!discordId) return;

  const username = String(applicant?.username || "").trim().slice(0, 32);
  const globalName = String(applicant?.globalName || applicant?.global_name || username).trim().slice(0, 80);
  const avatar = String(applicant?.avatar || "").replace(/[^a-zA-Z0-9_]/g, "").slice(0, 64);

  await query(
    `
      INSERT INTO guild_applicants (discord_id, username, global_name, avatar)
      VALUES ($1, $2, $3, $4)
      ON CONFLICT (discord_id) DO UPDATE SET
        username = COALESCE(NULLIF(EXCLUDED.username, ''), guild_applicants.username),
        global_name = COALESCE(NULLIF(EXCLUDED.global_name, ''), guild_applicants.global_name),
        avatar = COALESCE(NULLIF(EXCLUDED.avatar, ''), guild_applicants.avatar),
        updated_at = now()
    `,
    [discordId, username, globalName, avatar],
  );
}

async function listApplicants() {
  const result = await query(`
    WITH accounts AS (
      SELECT
        u.discord_id,
        COALESCE(NULLIF(u.username, ''), NULLIF(a.username, ''), '') AS username,
        COALESCE(NULLIF(u.global_name, ''), NULLIF(a.global_name, '')) AS global_name,
        COALESCE(NULLIF(u.avatar, ''), NULLIF(a.avatar, '')) AS avatar,
        a.main_character_name
      FROM users u
      LEFT JOIN guild_applicants a ON a.discord_id = u.discord_id
      WHERE u.discord_id ~ '^\\d{17,20}$'

      UNION ALL

      SELECT
        a.discord_id,
        COALESCE(a.username, ''),
        NULLIF(a.global_name, ''),
        NULLIF(a.avatar, ''),
        a.main_character_name
      FROM guild_applicants a
      WHERE a.discord_id ~ '^\\d{17,20}$'
        AND NOT EXISTS (
          SELECT 1 FROM users u WHERE u.discord_id = a.discord_id
        )
    )
    SELECT
      discord_id AS "discordId",
      username,
      global_name AS "globalName",
      avatar,
      COALESCE(main_character_name, '') AS "mainCharacterName"
    FROM accounts
    ORDER BY lower(COALESCE(NULLIF(global_name, ''), username)), discord_id
  `);

  return result.rows;
}

async function setApplicantMains(rows) {
  if (!Array.isArray(rows)) throw fail("Applicant mains are missing.", 400);

  const updates = rows.map((row) => ({
    discordId: cleanDiscordId(row?.discordId),
    mainCharacterName: cleanMainCharacterName(row?.mainCharacterName),
  }));

  if (updates.some((row) => !row.discordId)) {
    throw fail("That Discord account is not saved.", 400);
  }

  const wanted = updates.map((row) => row.mainCharacterName.toLowerCase()).filter(Boolean);
  if (new Set(wanted).size !== wanted.length) {
    throw fail("Each main character can belong to one Discord account.", 400);
  }

  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    for (const row of updates) {
      const result = await client.query(
        `
          INSERT INTO guild_applicants (discord_id, username, global_name, avatar, main_character_name)
          SELECT discord_id, username, global_name, avatar, NULLIF($2, '')
          FROM (
            SELECT
              discord_id,
              LEFT(COALESCE(username, ''), 32) AS username,
              LEFT(COALESCE(global_name, ''), 80) AS global_name,
              LEFT(COALESCE(avatar, ''), 64) AS avatar
            FROM users
            WHERE discord_id = $1
            UNION ALL
            SELECT
              discord_id,
              LEFT(COALESCE(username, ''), 32),
              LEFT(COALESCE(global_name, ''), 80),
              LEFT(COALESCE(avatar, ''), 64)
            FROM guild_applicants
            WHERE discord_id = $1
              AND NOT EXISTS (SELECT 1 FROM users WHERE discord_id = $1)
          ) account
          ON CONFLICT (discord_id) DO UPDATE SET
            main_character_name = EXCLUDED.main_character_name,
            updated_at = now()
        `,
        [row.discordId, row.mainCharacterName],
      );
      if (result.rowCount !== 1) throw fail("That Discord account is not saved.", 400);
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }

  return listApplicants();
}

module.exports = {
  cleanMainCharacterName,
  listApplicants,
  rememberApplicant,
  setApplicantMains,
};

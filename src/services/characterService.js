const { query } = require("../db/pool");

function mapCharacter(row) {
  return {
    id: row.id,
    name: row.name,
    realm: row.realm,
    region: row.region,
    class: row.class,
    spec: row.spec || "",
    role: row.role || "DPS",
    ilvl: row.item_level,
    level: row.level,
    isMain: row.is_main,
    armoryUrl: row.armory_url,
    warcraftlogsUrl: row.warcraftlogs_url,
  };
}

async function listCharactersForUser(userId) {
  const result = await query(
    `
      SELECT id, name, realm, region, class, spec, role, item_level, level, is_main, armory_url, warcraftlogs_url
      FROM characters
      WHERE user_id = $1
      ORDER BY is_main DESC, COALESCE(level, 0) DESC, COALESCE(item_level, 0) DESC, name ASC
    `,
    [userId],
  );

  return result.rows.map(mapCharacter);
}

async function getCharacterForUser(userId, characterId) {
  const characters = await listCharactersForUser(userId);
  return characters.find((character) => String(character.id) === String(characterId)) || null;
}

async function replaceCharactersForUser(userId, characters) {
  const mainIndex = characters.reduce((best, character, index) => {
    const current = characters[best] || { level: 0, itemLevel: 0 };
    const score = (Number(character.level) || 0) * 1000 + (Number(character.itemLevel) || 0);
    const bestScore = (Number(current.level) || 0) * 1000 + (Number(current.itemLevel) || 0);
    return score > bestScore ? index : best;
  }, 0);

  await query("DELETE FROM characters WHERE user_id = $1", [userId]);

  const saved = [];

  for (const [index, character] of characters.entries()) {
    const result = await query(
      `
        INSERT INTO characters (
          user_id,
          name,
          realm,
          region,
          class,
          spec,
          role,
          item_level,
          level,
          is_main,
          armory_url,
          battlenet_character_id
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
        RETURNING id, name, realm, region, class, spec, role, item_level, level, is_main, armory_url, warcraftlogs_url
      `,
      [
        userId,
        character.name,
        character.realm || "",
        character.region || "eu",
        character.className,
        character.spec || "",
        character.role || "DPS",
        character.itemLevel,
        character.level,
        index === mainIndex,
        character.armoryUrl || null,
        character.battlenetCharacterId || null,
      ],
    );

    saved.push(mapCharacter(result.rows[0]));
  }

  return saved;
}

async function deleteCharactersForUser(userId) {
  await query("DELETE FROM characters WHERE user_id = $1", [userId]);
}

async function updateCharacterWarcraftLogsUrl(characterId, url) {
  await query(
    `
      UPDATE characters
      SET warcraftlogs_url = $2
      WHERE id = $1
    `,
    [characterId, url],
  );
}

module.exports = {
  listCharactersForUser,
  getCharacterForUser,
  replaceCharactersForUser,
  updateCharacterWarcraftLogsUrl,
  deleteCharactersForUser,
};

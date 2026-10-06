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

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function objectValues(value) {
  if (Array.isArray(value)) return value;
  if (isPlainObject(value)) return Object.values(value);
  return [];
}

function collectRosterMembers(payload) {
  const source = payload?.roster;
  if (Array.isArray(source)) {
    return source
      .map((member) => normalizeRosterMember(member))
      .filter(Boolean);
  }
  if (!isPlainObject(source)) return [];

  return Object.entries(source)
    .map(([key, member]) => normalizeRosterMember(member, key))
    .filter(Boolean);
}

function normalizeRosterMember(member, fallbackName) {
  if (!member || typeof member !== "object") return null;
  const name = asTrimmedString(member.name) || asTrimmedString(fallbackName);
  if (!name) return null;
  return { ...member, name };
}

function fromUnixSeconds(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  return new Date(n * 1000);
}

function parseTimestamp(value) {
  const fromUnix = fromUnixSeconds(value);
  if (fromUnix) return fromUnix;
  if (typeof value === "string" && value.trim()) {
    const date = new Date(value);
    if (!Number.isNaN(date.getTime())) return date;
  }
  return null;
}

const PROFESSION_NAME_IDS = {
  alchemy: 171,
  blacksmithing: 164,
  enchanting: 333,
  engineering: 202,
  leatherworking: 165,
  tailoring: 197,
  herbalism: 182,
  mining: 186,
  smelting: 186,
  skinning: 393,
  cooking: 185,
  "first aid": 129,
  firstaid: 129,
  fishing: 356,
  jewelcrafting: 755,
  inscription: 773,
  poisons: 40,
};

const RANK_INDEX_BY_NAME = {
  guildmaster: 0,
  gm: 0,
  marshal: 1,
  vanguard: 2,
  pathfinder: 3,
  member: 4,
  altleadership: 5,
  altplayer: 6,
  newcomer: 7,
};

function rankKey(value) {
  return asTrimmedString(value).toLowerCase().replace(/[\s\-_]/g, "");
}

function rankIndexFromName(value) {
  const mapped = RANK_INDEX_BY_NAME[rankKey(value)];
  return mapped == null ? null : mapped;
}

function skillLineIdFromProfession(profession) {
  const explicit = asInteger(profession?.skillLineID ?? profession?.skillLineId ?? profession?.key);
  if (explicit != null) return explicit;
  const name = asTrimmedString(profession?.name || profession?.professionName || profession?.profession).toLowerCase();
  return PROFESSION_NAME_IDS[name] ?? null;
}

function buildLastOnlineText(member) {
  const existing = asTrimmedString(
    member?.lastOnline || member?.last_online || member?.lastOnlineText,
  );
  if (existing) return existing;

  const years = asInteger(member?.lastOnlineYears) || 0;
  const months = asInteger(member?.lastOnlineMonths) || 0;
  const days = asInteger(member?.lastOnlineDays) || 0;
  const hours = asInteger(member?.lastOnlineHours) || 0;
  const hasParts = [
    member?.lastOnlineYears,
    member?.lastOnlineMonths,
    member?.lastOnlineDays,
    member?.lastOnlineHours,
  ].some((value) => value != null && value !== "");
  if (!hasParts) return "";

  const parts = [];
  if (years > 0) parts.push(`${years}y`);
  if (months > 0) parts.push(`${months}m`);
  if (days > 0) parts.push(`${days}d`);
  if (hours > 0 || parts.length === 0) parts.push(`${hours}h`);
  return parts.join(" ");
}

function ageSeconds(member) {
  const hasNumbers = [
    member?.lastOnlineYears,
    member?.lastOnlineMonths,
    member?.lastOnlineDays,
    member?.lastOnlineHours,
  ].some((value) => asInteger(value) != null);
  let years = 0;
  let months = 0;
  let days = 0;
  let hours = 0;

  if (hasNumbers) {
    years = asInteger(member.lastOnlineYears) || 0;
    months = asInteger(member.lastOnlineMonths) || 0;
    days = asInteger(member.lastOnlineDays) || 0;
    hours = asInteger(member.lastOnlineHours) || 0;
  } else {
    const text = asTrimmedString(member?.lastOnline || member?.last_online || member?.lastOnlineText);
    if (!text || text.toLowerCase() === "online") return 0;
    const yearPart = text.match(/(\d+)\s*y/i);
    const monthPart = text.match(/(\d+)\s*m(?![a-z])/i);
    const dayPart = text.match(/(\d+)\s*d/i);
    const hourPart = text.match(/(\d+)\s*h/i);
    if (!yearPart && !monthPart && !dayPart && !hourPart) return null;
    years = yearPart ? Number(yearPart[1]) : 0;
    months = monthPart ? Number(monthPart[1]) : 0;
    days = dayPart ? Number(dayPart[1]) : 0;
    hours = hourPart ? Number(hourPart[1]) : 0;
  }

  return ((years * 365) + (months * 30) + days) * 86400 + hours * 3600;
}

function resolveLastOnlineAt(member) {
  const explicit = asInteger(member?.lastOnlineAt);
  if (explicit != null && explicit > 0) return explicit;
  const seconds = ageSeconds(member);
  if (seconds == null) return null;
  return Math.floor(Date.now() / 1000) - seconds;
}

function parseLastOnline(member) {
  const text = buildLastOnlineText(member);
  const online = asBoolean(member?.online) || text.toLowerCase() === "online";
  if (online) {
    return { online: true, lastOnlineDays: 0, lastOnlineHours: 0, lastOnlineText: "online" };
  }

  const years = asInteger(member?.lastOnlineYears) || 0;
  const months = asInteger(member?.lastOnlineMonths) || 0;
  const daysField = asInteger(member?.lastOnlineDays);
  let hours = asInteger(member?.lastOnlineHours);
  let days = years * 365 + months * 30 + (daysField || 0);

  if (text) {
    const yearPart = text.match(/(\d+)\s*y/i);
    const monthPart = text.match(/(\d+)\s*m(?![a-z])/i);
    const dayPart = text.match(/(\d+)\s*d/i);
    const hourPart = text.match(/(\d+)\s*h/i);
    if (!days) {
      if (yearPart) days += Number(yearPart[1]) * 365;
      if (monthPart) days += Number(monthPart[1]) * 30;
      if (dayPart) days += Number(dayPart[1]);
    }
    if (hours == null && hourPart) hours = Number(hourPart[1]);
  }

  return {
    online: false,
    lastOnlineDays: daysField != null || days > 0 || text || hours != null ? days : null,
    lastOnlineHours: hours,
    lastOnlineText: text || null,
  };
}

function normalizeMaterials(value) {
  const list = objectValues(value)
    .map((material) => {
      if (!material || typeof material !== "object") return null;
      const name = asTrimmedString(material.name);
      if (!name) return null;
      return {
        itemID: asInteger(material.itemID ?? material.itemId) || 0,
        name,
        quantity: asInteger(material.quantity) || 1,
      };
    })
    .filter(Boolean);

  return list.length > 0 ? list : null;
}

function normalizeRecipe(recipe, fallbackCharacterName) {
  if (!recipe || typeof recipe !== "object") return null;
  const recipeId = asInteger(recipe.recipeID ?? recipe.recipeId ?? recipe.id);
  if (recipeId == null) return null;
  return {
    characterName: asTrimmedString(recipe.characterName) || fallbackCharacterName,
    recipeID: recipeId,
    recipeName: asTrimmedString(recipe.recipeName || recipe.name) || null,
    learned: recipe.learned === false ? false : true,
    outputItemID: asInteger(recipe.outputItemID ?? recipe.outputItemId),
    icon: asTrimmedString(recipe.icon) || null,
    materials: normalizeMaterials(recipe.materials),
  };
}

function crafterNames(value) {
  if (Array.isArray(value)) return value.map(asTrimmedString).filter(Boolean);
  if (isPlainObject(value)) return Object.values(value).map(asTrimmedString).filter(Boolean);
  const single = asTrimmedString(value);
  return single ? [single] : [];
}

function mergeProfessionRow(target, incoming) {
  if (!incoming) return target;
  if (!target) {
    return {
      characterName: incoming.characterName,
      name: incoming.name,
      skillLineID: incoming.skillLineID,
      currentSkill: incoming.currentSkill,
      maxSkill: incoming.maxSkill,
      recipes: [...(incoming.recipes || [])],
    };
  }

  if (incoming.currentSkill != null) target.currentSkill = incoming.currentSkill;
  if (incoming.maxSkill != null) target.maxSkill = incoming.maxSkill;
  if (incoming.name) target.name = incoming.name;

  const seen = new Set(target.recipes.map((recipe) => recipe.recipeID));
  for (const recipe of incoming.recipes || []) {
    if (!seen.has(recipe.recipeID)) {
      target.recipes.push(recipe);
      seen.add(recipe.recipeID);
    }
  }
  return target;
}

function pushProfessionRow(rows, profession) {
  const characterName = asTrimmedString(profession?.characterName);
  const name = asTrimmedString(profession?.name || profession?.professionName || profession?.profession);
  const skillLineID = skillLineIdFromProfession({ ...profession, name });
  if (!characterName || !name || skillLineID == null) return;

  const recipes = objectValues(profession.recipes || profession.patterns)
    .map((recipe) => normalizeRecipe(recipe, characterName))
    .filter(Boolean);

  const key = `${characterName.toLowerCase()}:${skillLineID}`;
  rows.set(key, mergeProfessionRow(rows.get(key), {
    characterName,
    name,
    skillLineID,
    currentSkill: asInteger(profession.currentSkill),
    maxSkill: asInteger(profession.maxSkill),
    recipes,
  }));
}

function collectProfessionsFromTree(rows, tree) {
  const professions = tree?.professions || tree;
  if (!isPlainObject(professions)) return;

  for (const [key, entry] of Object.entries(professions)) {
    if (!entry || typeof entry !== "object") continue;
    const name = asTrimmedString(entry.name) || asTrimmedString(key);
    const patterns = objectValues(entry.patterns || entry.recipes);
    const holders = crafterNames(entry.holders);

    if (patterns.length === 0) {
      for (const characterName of holders) {
        pushProfessionRow(rows, {
          characterName,
          name,
          skillLineID: entry.skillLineID ?? entry.skillLineId ?? key,
        });
      }
      continue;
    }

    for (const pattern of patterns) {
      const names = crafterNames(pattern?.crafters);
      const crafters = names.length > 0 ? names : holders;
      for (const characterName of crafters) {
        pushProfessionRow(rows, {
          characterName,
          name,
          skillLineID: entry.skillLineID ?? entry.skillLineId ?? key,
          recipes: [pattern],
        });
      }
    }
  }
}

function collectProfessionsFromCharacterStores(rows, stores) {
  for (const store of objectValues(stores)) {
    if (!store || typeof store !== "object") continue;
    const characterName = asTrimmedString(store.characterName);
    const nested = store.professions;
    if (!characterName || (!isPlainObject(nested) && !Array.isArray(nested))) continue;

    const entries = Array.isArray(nested)
      ? nested.map((profession) => [profession?.name, profession])
      : Object.entries(nested);

    for (const [key, profession] of entries) {
      if (!profession || typeof profession !== "object") continue;
      pushProfessionRow(rows, {
        ...profession,
        name: profession.name || profession.professionName || key,
        skillLineID: profession.skillLineID ?? profession.skillLineId ?? key,
        characterName: profession.characterName || characterName,
      });
    }
  }
}

function collectProfessionsFromCatalog(rows, catalog) {
  for (const entry of objectValues(catalog)) {
    if (!entry || typeof entry !== "object") continue;
    pushProfessionRow(rows, {
      characterName: entry.crafterName || entry.characterName,
      name: entry.professionName || entry.name,
      skillLineID: entry.skillLineID ?? entry.skillLineId,
      currentSkill: entry.currentSkill,
      maxSkill: entry.maxSkill,
      recipes: [entry],
    });
  }
}

function collectProfessionsFromProfiles(rows, profiles) {
  for (const profile of objectValues(profiles)) {
    const characterName = asTrimmedString(profile?.owner?.characterName || profile?.characterName);
    const professions = objectValues(profile?.professions);
    for (const profession of professions) {
      pushProfessionRow(rows, { ...profession, characterName: profession?.characterName || characterName });
    }
  }
}

function collectProfessionRows(payload, rosterMembers) {
  const rows = new Map();

  if (Array.isArray(payload.professions)) {
    for (const profession of payload.professions) {
      if (profession?.professions) collectProfessionsFromCharacterStores(rows, [profession]);
      else pushProfessionRow(rows, profession);
    }
  } else if (isPlainObject(payload.professions)) {
    collectProfessionsFromTree(rows, payload.professions);
    collectProfessionsFromCharacterStores(rows, payload.professions);
  }

  collectProfessionsFromTree(rows, payload.professionTree);
  collectProfessionsFromCatalog(rows, payload.guildProfessionCatalog || payload.catalogue);
  collectProfessionsFromProfiles(rows, payload.guildProfiles || payload.profiles);
  collectProfessionsFromCharacterStores(rows, payload.characterProfessions);

  for (const member of rosterMembers) {
    for (const profession of objectValues(member?.professions)) {
      pushProfessionRow(rows, {
        ...profession,
        characterName: profession?.characterName || member.name,
      });
    }
  }

  return [...rows.values()];
}

function isFullProfessionSnapshot(payload) {
  return Boolean(
    payload.professionTree
    || payload.guildProfessionCatalog
    || payload.catalogue
    || payload.guildProfiles
    || payload.profiles
    || (isPlainObject(payload.professions) && !Array.isArray(payload.professions)),
  );
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

    const rankName = asTrimmedString(member.rankName || member.rank) || null;
    const lastOnline = parseLastOnline(member);

    await client.query(
      `INSERT INTO guild_roster_members (
        character_name, rank_index, rank_name, level, class, public_note, officer_note,
        online, last_online_days, last_online_hours, last_online_at, last_online_text
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
      ON CONFLICT (lower(character_name)) DO UPDATE SET
        character_name = EXCLUDED.character_name,
        rank_index = COALESCE(EXCLUDED.rank_index, guild_roster_members.rank_index),
        rank_name = COALESCE(EXCLUDED.rank_name, guild_roster_members.rank_name),
        level = COALESCE(EXCLUDED.level, guild_roster_members.level),
        class = COALESCE(EXCLUDED.class, guild_roster_members.class),
        public_note = EXCLUDED.public_note,
        officer_note = EXCLUDED.officer_note,
        online = EXCLUDED.online,
        last_online_days = COALESCE(EXCLUDED.last_online_days, guild_roster_members.last_online_days),
        last_online_hours = COALESCE(EXCLUDED.last_online_hours, guild_roster_members.last_online_hours),
        last_online_at = COALESCE(EXCLUDED.last_online_at, guild_roster_members.last_online_at),
        last_online_text = COALESCE(EXCLUDED.last_online_text, guild_roster_members.last_online_text)`,
      [
        characterName,
        asInteger(member.rankIndex) ?? rankIndexFromName(rankName),
        rankName,
        asInteger(member.level),
        asTrimmedString(member.class || member.classFile || member.className) || null,
        asTrimmedString(member.publicNote || member.note),
        asTrimmedString(member.officerNote),
        lastOnline.online,
        lastOnline.lastOnlineDays,
        lastOnline.lastOnlineHours,
        resolveLastOnlineAt(member),
        lastOnline.lastOnlineText,
      ],
    );
  }
}

async function deleteCharactersNotIn(client, names) {
  const kept = [...new Set(names.map((name) => name.toLowerCase()).filter(Boolean))];
  if (kept.length === 0) return;

  await client.query(
    `DELETE FROM guild_profession_recipes
     WHERE NOT (lower(character_name) = ANY($1::text[]))`,
    [kept],
  );
  await client.query(
    `DELETE FROM guild_professions
     WHERE NOT (lower(character_name) = ANY($1::text[]))`,
    [kept],
  );
  await client.query(
    `DELETE FROM guild_roster_members
     WHERE NOT (lower(character_name) = ANY($1::text[]))`,
    [kept],
  );
}

async function replaceProfessionTables(client) {
  await client.query("DELETE FROM guild_profession_recipes");
  await client.query("DELETE FROM guild_professions");
}

async function upsertProfessions(client, professions) {
  for (const profession of professions) {
    const characterName = asTrimmedString(profession?.characterName);
    const skillLineId = skillLineIdFromProfession(profession);
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
          character_name, skill_line_id, recipe_id, recipe_name, learned, output_item_id, icon, materials
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)
        ON CONFLICT (lower(character_name), skill_line_id, recipe_id) DO UPDATE SET
          character_name = EXCLUDED.character_name,
          recipe_name = EXCLUDED.recipe_name,
          learned = EXCLUDED.learned,
          output_item_id = EXCLUDED.output_item_id,
          icon = EXCLUDED.icon,
          materials = COALESCE(EXCLUDED.materials, guild_profession_recipes.materials)`,
        [
          asTrimmedString(recipe.characterName) || characterName,
          skillLineId,
          recipeId,
          asTrimmedString(recipe.recipeName) || null,
          recipe.learned === false ? false : true,
          asInteger(recipe.outputItemID ?? recipe.outputItemId),
          asTrimmedString(recipe.icon) || null,
          recipe.materials ? JSON.stringify(recipe.materials) : null,
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
  const roster = collectRosterMembers(payload);
  const professions = collectProfessionRows(payload, roster);
  const professionDrops = Array.isArray(payload.professionDrops) ? payload.professionDrops : [];
  const rosterUpdatedAt = parseTimestamp(payload.rosterUpdatedAt) || (roster.length > 0 ? new Date() : null);

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
      await deleteCharactersNotIn(client, roster.map((member) => asTrimmedString(member.name)));
    }

    if (isFullProfessionSnapshot(payload) && professions.length > 0) {
      await replaceProfessionTables(client);
    }

    if (professions.length > 0) {
      await upsertProfessions(client, professions);
    }

    if (professionDrops.length > 0) {
      await dropProfessions(client, professionDrops);
    }

    const [professionRows, recipeRows] = await Promise.all([
      client.query(`
        SELECT character_name, name, skill_line_id
        FROM guild_professions
      `),
      client.query(`
        SELECT character_name, skill_line_id, recipe_id, recipe_name
        FROM guild_profession_recipes
      `),
    ]);
    await dropCopiedProfessionRecipes(
      client,
      professionRows.rows,
      recipesByProfessionKey(recipeRows.rows),
    );
  });
}

function professionGroupName(row) {
  return String(row?.name || "").trim().toLowerCase();
}

function recipeLookupKey(characterName, skillLineId) {
  return `${String(characterName || "").toLowerCase()}:${skillLineId}`;
}

function intersectRecipeIds(sets) {
  if (sets.length === 0) return new Set();

  const [first, ...rest] = sets;
  if (rest.length === 0) return new Set(first);

  const kept = new Set();
  for (const value of first) {
    if (rest.every((set) => set.has(value))) kept.add(value);
  }
  return kept;
}

function recipesByProfessionKey(recipes) {
  const recipesByKey = new Map();
  for (const recipe of recipes) {
    const key = recipeLookupKey(recipe.character_name, recipe.skill_line_id);
    const list = recipesByKey.get(key) || [];
    list.push(recipe);
    recipesByKey.set(key, list);
  }
  return recipesByKey;
}

function canonicalRecipeIdsByCharacter(professionRows, recipesByKey) {
  const rowsByCharacter = new Map();
  for (const row of professionRows) {
    const characterKey = String(row.character_name || "").toLowerCase();
    const list = rowsByCharacter.get(characterKey) || [];
    list.push(row);
    rowsByCharacter.set(characterKey, list);
  }

  const canonicalByCharacter = new Map();
  for (const [characterKey, rows] of rowsByCharacter) {
    const linesByProfession = new Map();
    for (const row of rows) {
      const professionName = professionGroupName(row);
      if (!professionName) continue;
      const list = linesByProfession.get(professionName) || [];
      list.push(row);
      linesByProfession.set(professionName, list);
    }

    const canonicalByProfession = new Map();
    for (const [professionName, lines] of linesByProfession) {
      const idSets = lines.map((row) => new Set(
        (recipesByKey.get(recipeLookupKey(row.character_name, row.skill_line_id)) || [])
          .map((recipe) => recipe.recipe_id),
      ));
      canonicalByProfession.set(professionName, intersectRecipeIds(idSets));
    }

    canonicalByCharacter.set(characterKey, canonicalByProfession);
  }

  return canonicalByCharacter;
}

function belongingProfessionNames(recipeName, professionNames) {
  const names = [...professionNames];
  const isSmelt = /^\s*smelt\b/i.test(String(recipeName || ""));
  const mining = names.filter((name) => name === "mining");
  const others = names.filter((name) => name !== "mining");

  if (isSmelt) return mining.length > 0 ? mining : names;
  if (others.length > 0) return others;
  if (mining.length > 0) return [];
  return names;
}

function recipesForProfessionRow(row, recipesByKey, canonicalByCharacter) {
  const recipes = recipesByKey.get(recipeLookupKey(row.character_name, row.skill_line_id)) || [];
  const characterKey = String(row.character_name || "").toLowerCase();
  const professionName = professionGroupName(row);
  const canonicalByProfession = canonicalByCharacter.get(characterKey);
  const canonicalIds = canonicalByProfession?.get(professionName);

  return recipes.filter((recipe) => {
    if (canonicalIds && !canonicalIds.has(recipe.recipe_id)) return false;

    const owners = [];
    if (canonicalByProfession) {
      for (const [name, ids] of canonicalByProfession) {
        if (ids.has(recipe.recipe_id)) owners.push(name);
      }
    }

    const kept = belongingProfessionNames(recipe.recipe_name, owners.length > 0 ? owners : [professionName]);
    return kept.includes(professionName);
  });
}

async function dropCopiedProfessionRecipes(client, professionRows, recipesByKey) {
  const canonicalByCharacter = canonicalRecipeIdsByCharacter(professionRows, recipesByKey);

  for (const row of professionRows) {
    const kept = recipesForProfessionRow(row, recipesByKey, canonicalByCharacter);
    const keptIds = kept.map((recipe) => recipe.recipe_id);
    if (keptIds.length === 0) {
      await client.query(
        `DELETE FROM guild_profession_recipes
         WHERE lower(character_name) = lower($1) AND skill_line_id = $2`,
        [row.character_name, row.skill_line_id],
      );
      continue;
    }

    await client.query(
      `DELETE FROM guild_profession_recipes
       WHERE lower(character_name) = lower($1)
         AND skill_line_id = $2
         AND NOT (recipe_id = ANY($3::int[]))`,
      [row.character_name, row.skill_line_id, keptIds],
    );
  }
}

function presentMember(row) {
  return {
    name: row.character_name,
    rankIndex: row.rank_index ?? rankIndexFromName(row.rank_name),
    rankName: row.rank_name || "",
    level: row.level,
    class: row.class || "",
    publicNote: row.public_note || "",
    online: Boolean(row.online),
    lastOnlineDays: row.last_online_days,
    lastOnlineHours: row.last_online_hours,
    lastOnline: row.last_online_text || "",
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
      outputItemID: recipe.output_item_id || null,
      icon: recipe.icon || "",
      materials: Array.isArray(recipe.materials) ? recipe.materials : [],
    })),
  };
}

async function listGuildRoster() {
  const client = await getPool().connect();
  try {
    const [meta, members, professions, recipes] = await Promise.all([
      client.query("SELECT roster_updated_at AS \"rosterUpdatedAt\" FROM guild_roster_meta WHERE id = 1"),
      client.query(`
        SELECT character_name, rank_index, rank_name, level, class, public_note, online, last_online_days, last_online_hours, last_online_text
        FROM guild_roster_members
        ORDER BY rank_index ASC NULLS LAST, lower(character_name) ASC
      `),
      client.query(`
        SELECT character_name, name, skill_line_id, current_skill, max_skill
        FROM guild_professions
        ORDER BY lower(character_name) ASC, lower(name) ASC
      `),
      client.query(`
        SELECT character_name, skill_line_id, recipe_id, recipe_name, learned, output_item_id, icon, materials
        FROM guild_profession_recipes
        ORDER BY lower(recipe_name) ASC, recipe_id ASC
      `),
    ]);

    const recipesByKey = recipesByProfessionKey(recipes.rows);
    const canonicalByCharacter = canonicalRecipeIdsByCharacter(professions.rows, recipesByKey);

    return {
      rosterUpdatedAt: meta.rows[0]?.rosterUpdatedAt || null,
      members: members.rows.map(presentMember),
      professions: professions.rows.map((row) => (
        presentProfession(row, recipesForProfessionRow(row, recipesByKey, canonicalByCharacter))
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

const { query } = require("../db/pool");
const adminService = require("./adminService");
const s3 = require("./s3Service");
const { normalizeVideoLink } = require("./triviaMedia");
const { DIFFICULTIES, QUESTION_TYPES, STATUSES } = require("./triviaValidation");

const DISCORD_SNOWFLAKE = /^\d{17,20}$/;
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

const QUESTION_COLUMNS = `
  id, type, prompt, explanation, category, tags, difficulty,
  time_limit_seconds, points, status, media, answer,
  created_by_discord_id, created_at, updated_at
`;

class TriviaError extends Error {
  constructor(statusCode, message, fields) {
    super(message);
    this.statusCode = statusCode;
    if (fields) this.fields = fields;
  }
}

function toIso(value) {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

async function presentMedia(stored) {
  if (!stored) return null;

  const media = {
    kind: stored.kind,
    source: stored.source,
  };

  if (stored.source === "upload") {
    media.key = stored.key;
    try {
      const signed = await s3.getTriviaSignedUrl(stored.key);
      media.url = signed.url;
      media.expiresAt = signed.expiresAt;
    } catch (error) {
      console.error("Trivia media URL could not be signed:", error.message);
      media.url = "";
      media.expiresAt = null;
    }
  } else {
    media.sourceUrl = stored.sourceUrl;
    media.url = normalizeVideoLink(stored.sourceUrl);
    media.expiresAt = null;
  }

  if (stored.kind !== "image") {
    media.startSeconds = Number.isFinite(stored.startSeconds) ? stored.startSeconds : 0;
    media.endSeconds = Number.isFinite(stored.endSeconds) ? stored.endSeconds : null;
  }

  return media;
}

async function presentQuestion(row) {
  return {
    id: row.id,
    type: row.type,
    prompt: row.prompt,
    explanation: row.explanation,
    category: row.category,
    tags: row.tags || [],
    difficulty: row.difficulty,
    timeLimitSeconds: row.time_limit_seconds,
    points: row.points,
    status: row.status,
    media: await presentMedia(row.media),
    answer: row.answer,
    createdByDiscordId: row.created_by_discord_id,
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
  };
}

function storedMedia(media) {
  if (!media) return null;
  const stored = { kind: media.kind, source: media.source };
  if (media.source === "upload") {
    stored.key = media.key;
  } else {
    stored.sourceUrl = media.sourceUrl;
  }
  if (media.kind !== "image") {
    stored.startSeconds = media.startSeconds ?? 0;
    stored.endSeconds = media.endSeconds ?? null;
  }
  return stored;
}

function mediaKey(media) {
  return media && media.source === "upload" && media.key ? media.key : "";
}

function escapeLike(text) {
  return text.replace(/[\\%_]/g, (character) => `\\${character}`);
}

function readInt(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) ? parsed : fallback;
}

function single(value) {
  return Array.isArray(value) ? value[0] : value;
}

function parseListFilters(rawQuery = {}) {
  const fields = {};
  const filters = {};

  const enumFilter = (name, allowed) => {
    const value = single(rawQuery[name]);
    if (value === undefined || value === "") return;
    if (!allowed.includes(value)) {
      fields[name] = `Must be one of: ${allowed.join(", ")}.`;
      return;
    }
    filters[name] = value;
  };

  enumFilter("type", QUESTION_TYPES);
  enumFilter("status", STATUSES);
  enumFilter("difficulty", DIFFICULTIES);

  const category = single(rawQuery.category);
  if (typeof category === "string" && category.trim()) filters.category = category.trim();

  const tag = single(rawQuery.tag);
  if (typeof tag === "string" && tag.trim()) filters.tag = tag.trim().toLowerCase();

  const search = single(rawQuery.q);
  if (typeof search === "string" && search.trim()) filters.q = search.trim().slice(0, 200);

  if (Object.keys(fields).length > 0) {
    throw new TriviaError(400, "One or more filters are not valid.", fields);
  }

  filters.limit = Math.min(Math.max(readInt(single(rawQuery.limit), DEFAULT_LIMIT), 1), MAX_LIMIT);
  filters.offset = Math.max(readInt(single(rawQuery.offset), 0), 0);
  return filters;
}

function buildWhere(filters) {
  const clauses = [];
  const params = [];
  const add = (sql, value) => {
    params.push(value);
    clauses.push(sql.replace("?", `$${params.length}`));
  };

  if (filters.type) add("type = ?", filters.type);
  if (filters.category) add("category = ?", filters.category);
  if (filters.status) add("status = ?", filters.status);
  if (filters.difficulty) add("difficulty = ?", filters.difficulty);
  if (filters.tag) add("? = ANY(tags)", filters.tag);
  if (filters.q) {
    params.push(`%${escapeLike(filters.q)}%`);
    const placeholder = `$${params.length}`;
    clauses.push(`(prompt ILIKE ${placeholder} ESCAPE '\\' OR explanation ILIKE ${placeholder} ESCAPE '\\')`);
  }

  return {
    where: clauses.length ? `WHERE ${clauses.join(" AND ")}` : "",
    params,
  };
}

async function listQuestions(rawQuery) {
  const filters = parseListFilters(rawQuery);
  const { where, params } = buildWhere(filters);

  const [rows, count] = await Promise.all([
    query(
      `SELECT ${QUESTION_COLUMNS} FROM trivia_questions ${where}
       ORDER BY created_at DESC, id DESC
       LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, filters.limit, filters.offset],
    ),
    query(`SELECT count(*)::int AS total FROM trivia_questions ${where}`, params),
  ]);

  return {
    questions: await Promise.all(rows.rows.map(presentQuestion)),
    total: count.rows[0].total,
  };
}

async function getQuestion(id) {
  const result = await query(`SELECT ${QUESTION_COLUMNS} FROM trivia_questions WHERE id = $1`, [id]);
  return result.rows[0] ? presentQuestion(result.rows[0]) : null;
}

async function isKeyReferenced(key) {
  const result = await query(
    `SELECT 1 FROM trivia_questions
     WHERE media->>'source' = 'upload' AND media->>'key' = $1
     LIMIT 1`,
    [key],
  );
  return result.rowCount > 0;
}

async function deleteMediaIfOrphaned(key, context) {
  if (!key) return;
  try {
    if (await isKeyReferenced(key)) return;
    await s3.deleteTriviaObject(key);
  } catch (error) {
    console.error(`Trivia media could not be removed after ${context}:`, error.message);
  }
}

async function verifyUploadedMedia(media) {
  const key = mediaKey(media);
  if (!key) return;

  const object = await s3.headTriviaObject(key);
  if (!object) {
    throw new TriviaError(400, "The uploaded media file was not found.", {
      "media.key": "That upload does not exist. Upload the file again.",
    });
  }
  if (object.contentType && !object.contentType.toLowerCase().startsWith(`${media.kind}/`)) {
    throw new TriviaError(400, "The uploaded media file does not match its kind.", {
      "media.key": `That upload is not ${media.kind} media.`,
    });
  }
}

async function createQuestion(value, createdByDiscordId) {
  await verifyUploadedMedia(value.media);
  const result = await query(
    `INSERT INTO trivia_questions (
       type, prompt, explanation, category, tags, difficulty,
       time_limit_seconds, points, status, media, answer, created_by_discord_id
     )
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11::jsonb, $12)
     RETURNING ${QUESTION_COLUMNS}`,
    [
      value.type,
      value.prompt,
      value.explanation,
      value.category,
      value.tags,
      value.difficulty,
      value.timeLimitSeconds,
      value.points,
      value.status,
      value.media ? JSON.stringify(storedMedia(value.media)) : null,
      JSON.stringify(value.answer),
      createdByDiscordId,
    ],
  );
  return presentQuestion(result.rows[0]);
}

async function replaceQuestion(id, value) {
  const existing = await query("SELECT media FROM trivia_questions WHERE id = $1", [id]);
  if (existing.rowCount === 0) return null;

  const oldKey = mediaKey(existing.rows[0].media);
  if (mediaKey(value.media) !== oldKey) {
    await verifyUploadedMedia(value.media);
  }

  const result = await query(
    `WITH previous AS (
       SELECT id, media FROM trivia_questions WHERE id = $1 FOR UPDATE
     )
     UPDATE trivia_questions q SET
       type = $2, prompt = $3, explanation = $4, category = $5, tags = $6,
       difficulty = $7, time_limit_seconds = $8, points = $9, status = $10,
       media = $11::jsonb, answer = $12::jsonb
     FROM previous
     WHERE q.id = previous.id
     RETURNING ${QUESTION_COLUMNS.split(",").map((column) => `q.${column.trim()}`).join(", ")},
       previous.media AS previous_media`,
    [
      id,
      value.type,
      value.prompt,
      value.explanation,
      value.category,
      value.tags,
      value.difficulty,
      value.timeLimitSeconds,
      value.points,
      value.status,
      value.media ? JSON.stringify(storedMedia(value.media)) : null,
      JSON.stringify(value.answer),
    ],
  );
  if (result.rowCount === 0) return null;

  const row = result.rows[0];
  const previousKey = mediaKey(row.previous_media);
  if (previousKey && previousKey !== mediaKey(value.media)) {
    await deleteMediaIfOrphaned(previousKey, "question update");
  }
  return presentQuestion(row);
}

async function deleteQuestion(id) {
  const result = await query("DELETE FROM trivia_questions WHERE id = $1 RETURNING media", [id]);
  if (result.rowCount === 0) return false;
  await deleteMediaIfOrphaned(mediaKey(result.rows[0].media), "question delete");
  return true;
}

async function duplicateQuestion(id, createdByDiscordId) {
  const source = await query(`SELECT ${QUESTION_COLUMNS} FROM trivia_questions WHERE id = $1`, [id]);
  if (source.rowCount === 0) return null;

  const row = source.rows[0];
  const sourceKey = mediaKey(row.media);
  let media = row.media;
  let copiedKey = "";

  if (sourceKey) {
    copiedKey = await s3.copyTriviaObject(sourceKey);
    media = { ...row.media, key: copiedKey };
  }

  try {
    const result = await query(
      `INSERT INTO trivia_questions (
         type, prompt, explanation, category, tags, difficulty,
         time_limit_seconds, points, status, media, answer, created_by_discord_id
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'draft', $9::jsonb, $10::jsonb, $11)
       RETURNING ${QUESTION_COLUMNS}`,
      [
        row.type,
        row.prompt,
        row.explanation,
        row.category,
        row.tags,
        row.difficulty,
        row.time_limit_seconds,
        row.points,
        media ? JSON.stringify(media) : null,
        JSON.stringify(row.answer),
        createdByDiscordId,
      ],
    );
    return presentQuestion(result.rows[0]);
  } catch (error) {
    if (copiedKey) {
      await s3.deleteTriviaObject(copiedKey).catch((cleanupError) => {
        console.error("Copied trivia media could not be cleaned up:", cleanupError.message);
      });
    }
    throw error;
  }
}

async function listCategories() {
  const result = await query(
    `SELECT category AS name, count(*)::int AS count
     FROM trivia_questions
     GROUP BY category
     ORDER BY lower(category), category`,
  );
  return { categories: result.rows };
}

async function removeUnreferencedMedia(key) {
  if (await isKeyReferenced(key)) {
    throw new TriviaError(409, "That media file is used by a question and cannot be removed.");
  }
  await s3.deleteTriviaObject(key);
}

async function isTriviaAdmin(discordId) {
  if (!discordId) return false;
  if (adminService.isOwner({ discordId })) return true;
  const result = await query("SELECT 1 FROM trivia_admins WHERE discord_id = $1 LIMIT 1", [discordId]);
  return result.rowCount > 0;
}

async function listTriviaAdmins() {
  const result = await query(
    `SELECT ta.discord_id, ta.added_by_discord_id, ta.created_at, u.username
     FROM trivia_admins ta
     LEFT JOIN users u ON u.discord_id = ta.discord_id
     ORDER BY ta.created_at ASC, ta.discord_id ASC`,
  );

  return {
    admins: result.rows.map((row) => ({
      discordId: row.discord_id,
      username: row.username || null,
      addedByDiscordId: row.added_by_discord_id || null,
      createdAt: toIso(row.created_at),
    })),
  };
}

function requireSnowflake(value) {
  const discordId = typeof value === "string" ? value.trim() : "";
  if (!DISCORD_SNOWFLAKE.test(discordId)) {
    throw new TriviaError(400, "A valid Discord account ID is required.", {
      discordId: "Must be a 17-20 digit Discord ID.",
    });
  }
  return discordId;
}

async function addTriviaAdmin(discordIdInput, addedByDiscordId) {
  const discordId = requireSnowflake(discordIdInput);
  if (!adminService.isOwner({ discordId })) {
    await query(
      `INSERT INTO trivia_admins (discord_id, added_by_discord_id)
       VALUES ($1, $2)
       ON CONFLICT (discord_id) DO NOTHING`,
      [discordId, addedByDiscordId || null],
    );
  }
  return listTriviaAdmins();
}

async function removeTriviaAdmin(discordIdInput) {
  const discordId = requireSnowflake(discordIdInput);
  if (adminService.isOwner({ discordId })) {
    throw new TriviaError(400, "The owner is always a trivia admin and cannot be removed.");
  }
  await query("DELETE FROM trivia_admins WHERE discord_id = $1", [discordId]);
  return listTriviaAdmins();
}

module.exports = {
  TriviaError,
  addTriviaAdmin,
  createQuestion,
  deleteQuestion,
  duplicateQuestion,
  getQuestion,
  isTriviaAdmin,
  listCategories,
  listQuestions,
  listTriviaAdmins,
  parseListFilters,
  presentQuestion,
  removeTriviaAdmin,
  removeUnreferencedMedia,
  replaceQuestion,
};

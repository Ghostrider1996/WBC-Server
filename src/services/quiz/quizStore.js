const { query } = require("../../db/pool");
const triviaService = require("../triviaService");
const { shuffled } = require("./quizScoring");
const { QUESTION_TYPES } = require("../triviaValidation");
const { typeLabel } = require("./quizSetup");

const UNIQUE_VIOLATION = "23505";

class QuizStoreError extends Error {
  constructor(statusCode, message) {
    super(message);
    this.statusCode = statusCode;
  }
}

function toIso(value) {
  if (!value) return null;
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function presentSession(row) {
  return {
    id: row.id,
    title: row.title,
    raidHelperEventId: row.raid_helper_event_id,
    allowedDiscordIds: Array.isArray(row.allowed_discord_ids) ? row.allowed_discord_ids.map(String) : [],
    hostDiscordId: row.host_discord_id,
    hostName: row.host_name || null,
    status: row.status,
    rounds: row.rounds,
    settings: row.settings || {},
    createdAt: toIso(row.created_at),
    startedAt: toIso(row.started_at),
    endedAt: toIso(row.ended_at),
  };
}

const SESSION_SELECT = `
  SELECT s.*, COALESCE(u.global_name, u.username) AS host_name
  FROM quiz_sessions s
  LEFT JOIN users u ON u.discord_id = s.host_discord_id
`;

/** Number of ready questions per type: kept for older consoles. */
async function readyTypeCounts() {
  const result = await query(
    `SELECT type, count(*)::int AS count
     FROM trivia_questions
     WHERE status = 'ready'
     GROUP BY type`,
  );
  const byType = new Map(result.rows.map((row) => [row.type, row.count]));
  return QUESTION_TYPES
    .filter((type) => byType.has(type))
    .map((type) => ({ type, label: typeLabel(type), count: byType.get(type) }));
}

/** Ready questions grouped by category: what a host builds a pool from. */
async function readyCategoryCounts() {
  const result = await query(
    `SELECT category AS name, count(*)::int AS count
     FROM trivia_questions
     WHERE status = 'ready'
     GROUP BY category
     ORDER BY lower(category), category`,
  );
  return result.rows;
}

async function createSession({ title, raidHelperEventId, allowedDiscordIds, hostDiscordId, rounds, settings }) {
  try {
    const result = await query(
      `INSERT INTO quiz_sessions (title, raid_helper_event_id, host_discord_id, rounds, settings, allowed_discord_ids)
       VALUES ($1, $2, $3, $4::jsonb, $5::jsonb, $6::jsonb)
       RETURNING id`,
      [
        title,
        raidHelperEventId ? String(raidHelperEventId) : null,
        hostDiscordId,
        JSON.stringify(rounds),
        JSON.stringify(settings),
        allowedDiscordIds ? JSON.stringify(allowedDiscordIds) : null,
      ],
    );
    return getSession(result.rows[0].id);
  } catch (error) {
    if (error.code === UNIQUE_VIOLATION) {
      throw new QuizStoreError(409, "There is already an open quiz for this event. Cancel it first.");
    }
    throw error;
  }
}

async function getSession(id) {
  const result = await query(`${SESSION_SELECT} WHERE s.id = $1`, [id]);
  return result.rows[0] ? presentSession(result.rows[0]) : null;
}

async function listOpenSessions() {
  const result = await query(
    `${SESSION_SELECT} WHERE s.status IN ('lobby', 'live') ORDER BY s.created_at DESC`,
  );
  return result.rows.map(presentSession);
}

/**
 * Draws the asked count from each type, then shuffles the combined list so
 * types mix instead of playing in blocks.
 * Media links are signed now, when the quiz starts, so they outlive the night.
 */
async function pickQuestions(pool, random = Math.random) {
  const types = Array.isArray(pool?.types) ? pool.types : [];
  if (types.length === 0) {
    throw new QuizStoreError(400, "Choose how many questions you want from at least one type.");
  }

  const picked = [];
  for (const entry of types) {
    const type = typeof entry === "string" ? entry : entry?.type;
    const count = typeof entry === "string" ? Number(pool.count) || 0 : Number(entry?.count) || 0;
    if (!type || count < 1) continue;

    const result = await query(
      "SELECT * FROM trivia_questions WHERE status = 'ready' AND type = $1",
      [type],
    );
    const chosen = shuffled(result.rows, random).slice(0, count);
    if (chosen.length < count) {
      throw new QuizStoreError(409, `${typeLabel(type)} no longer has ${count} ready question(s).`);
    }
    for (const row of chosen) {
      const question = await triviaService.presentQuestion(row);
      picked.push({ ...question, roundIndex: 0, roundTitle: typeLabel(question.type) });
    }
  }

  if (picked.length === 0) {
    throw new QuizStoreError(400, "Choose how many questions you want from at least one type.");
  }

  return shuffled(picked, random);
}

async function markStarted(sessionId, questions) {
  await query(
    "UPDATE quiz_sessions SET status = 'live', started_at = now() WHERE id = $1 AND status = 'lobby'",
    [sessionId],
  );

  for (let position = 0; position < questions.length; position += 1) {
    const question = questions[position];
    await query(
      `INSERT INTO quiz_session_questions (session_id, position, round_index, question_id, snapshot)
       VALUES ($1, $2, $3, $4, $5::jsonb)
       ON CONFLICT (session_id, position) DO NOTHING`,
      [
        sessionId,
        position,
        question.roundIndex,
        question.id,
        JSON.stringify({
          prompt: question.prompt,
          category: question.category,
          type: question.type,
          points: question.points,
        }),
      ],
    );
  }
}

/** Saves one graded question: every player's answer, and the running totals. */
async function saveLockedQuestion(sessionId, { index, results, standings }) {
  for (const entry of standings) {
    await query(
      `INSERT INTO quiz_players (session_id, discord_id, display_name, score, correct_count, total_time_ms)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (session_id, discord_id) DO UPDATE SET
         display_name = EXCLUDED.display_name,
         score = EXCLUDED.score,
         correct_count = EXCLUDED.correct_count,
         total_time_ms = EXCLUDED.total_time_ms`,
      [sessionId, entry.discordId, entry.name, entry.score, entry.correctCount, entry.totalTimeMs],
    );
  }

  for (const result of results) {
    await query(
      `INSERT INTO quiz_answers (session_id, position, discord_id, response, verdict, points, elapsed_ms)
       VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7)
       ON CONFLICT (session_id, position, discord_id) DO NOTHING`,
      [
        sessionId,
        index,
        result.discordId,
        JSON.stringify(result.response ?? null),
        result.verdict,
        result.points,
        result.elapsedMs ?? null,
      ],
    );
  }
}

async function markFinished(sessionId, { cancelled, standings = [] }) {
  await query(
    `UPDATE quiz_sessions SET status = $2, ended_at = now()
     WHERE id = $1 AND status IN ('lobby', 'live')`,
    [sessionId, cancelled ? "cancelled" : "ended"],
  );

  for (const entry of standings) {
    await query(
      "UPDATE quiz_players SET final_rank = $3 WHERE session_id = $1 AND discord_id = $2",
      [sessionId, entry.discordId, entry.rank],
    );
  }
}

async function getResults(sessionId) {
  const session = await getSession(sessionId);
  if (!session) return null;

  const players = await query(
    `SELECT discord_id, display_name, score, correct_count, total_time_ms, final_rank
     FROM quiz_players WHERE session_id = $1
     ORDER BY score DESC, total_time_ms ASC, display_name ASC`,
    [sessionId],
  );

  return {
    session,
    players: players.rows.map((row) => ({
      discordId: row.discord_id,
      name: row.display_name,
      score: row.score,
      correctCount: row.correct_count,
      totalTimeMs: Number(row.total_time_ms),
      rank: row.final_rank,
    })),
  };
}

/** The Discord name and avatar shown next to a player's score. */
async function getPlayerProfile(discordId) {
  const result = await query(
    "SELECT username, global_name, avatar FROM users WHERE discord_id = $1",
    [String(discordId)],
  );
  const row = result.rows[0];
  return {
    name: row?.global_name || row?.username || "Player",
    avatar: row?.avatar || null,
  };
}

async function wasPlayer(sessionId, discordId) {
  const result = await query(
    "SELECT 1 FROM quiz_players WHERE session_id = $1 AND discord_id = $2 LIMIT 1",
    [sessionId, discordId],
  );
  return result.rowCount > 0;
}

module.exports = {
  QuizStoreError,
  createSession,
  getPlayerProfile,
  getResults,
  getSession,
  listOpenSessions,
  markFinished,
  markStarted,
  pickQuestions,
  readyCategoryCounts,
  readyTypeCounts,
  saveLockedQuestion,
  wasPlayer,
};

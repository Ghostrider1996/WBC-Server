const { query } = require("../../db/pool");
const triviaService = require("../triviaService");
const { shuffled } = require("./quizScoring");

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

/** Number of ready questions per category: what a host can build rounds from. */
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

async function createSession({ title, raidHelperEventId, hostDiscordId, rounds, settings }) {
  try {
    const result = await query(
      `INSERT INTO quiz_sessions (title, raid_helper_event_id, host_discord_id, rounds, settings)
       VALUES ($1, $2, $3, $4::jsonb, $5::jsonb)
       RETURNING id`,
      [title, String(raidHelperEventId), hostDiscordId, JSON.stringify(rounds), JSON.stringify(settings)],
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
 * Draws each round's questions at random from the ready ones in its category.
 * Media links are signed now, when the quiz starts, so they outlive the night.
 */
async function pickQuestions(rounds, random = Math.random) {
  const picked = [];

  for (let roundIndex = 0; roundIndex < rounds.length; roundIndex += 1) {
    const round = rounds[roundIndex];
    const result = await query(
      "SELECT * FROM trivia_questions WHERE status = 'ready' AND category = $1",
      [round.category],
    );

    const chosen = shuffled(result.rows, random).slice(0, round.count);
    if (chosen.length < round.count) {
      throw new QuizStoreError(409, `${round.category} no longer has ${round.count} ready question(s).`);
    }
    for (const row of chosen) {
      const question = await triviaService.presentQuestion(row);
      picked.push({ ...question, roundIndex, roundTitle: round.category });
    }
  }

  return picked;
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
  saveLockedQuestion,
  wasPlayer,
};

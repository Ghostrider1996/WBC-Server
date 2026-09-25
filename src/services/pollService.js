const { getPool, query } = require("../db/pool");

const MIN_OPTIONS = 2;
const MAX_OPTIONS = 10;
const MAX_QUESTION_LENGTH = 300;
const MAX_OPTION_LENGTH = 100;

function badRequest(message) {
  const error = new Error(message);
  error.statusCode = 400;
  return error;
}

function mapPoll(rows) {
  if (!rows.length) return null;

  const first = rows[0];
  const options = rows
    .filter((row) => row.option_id)
    .map((row) => ({
      id: row.option_id,
      label: row.label,
      sortOrder: row.sort_order,
      votes: Number(row.vote_count || 0),
    }));

  return {
    id: first.id,
    question: first.question,
    allowMultiple: Boolean(first.allow_multiple),
    endsAt: first.ends_at,
    createdAt: first.created_at,
    author: first.author_name || "",
    options,
  };
}

const POLL_SELECT = `
  SELECT
    polls.id,
    polls.question,
    polls.allow_multiple,
    polls.ends_at,
    polls.created_at,
    COALESCE(users.global_name, users.username, '') AS author_name,
    poll_options.id AS option_id,
    poll_options.label,
    poll_options.sort_order,
    COUNT(poll_votes.id)::int AS vote_count
  FROM polls
  LEFT JOIN users ON users.id = polls.created_by
  LEFT JOIN poll_options ON poll_options.poll_id = polls.id
  LEFT JOIN poll_votes ON poll_votes.option_id = poll_options.id
`;

async function getPollById(id, client = null) {
  const runner = client || { query };
  const result = await runner.query(
    `
      ${POLL_SELECT}
      WHERE polls.id = $1
      GROUP BY polls.id, users.global_name, users.username, poll_options.id
      ORDER BY poll_options.sort_order ASC, poll_options.created_at ASC
    `,
    [id],
  );

  return mapPoll(result.rows);
}

function cleanOptions(rawOptions) {
  if (!Array.isArray(rawOptions)) {
    throw badRequest("A poll needs at least two options.");
  }

  const options = rawOptions
    .map((option) => String(option || "").trim().slice(0, MAX_OPTION_LENGTH))
    .filter(Boolean);

  if (options.length < MIN_OPTIONS) {
    throw badRequest("A poll needs at least two options.");
  }

  if (options.length > MAX_OPTIONS) {
    throw badRequest(`A poll can have at most ${MAX_OPTIONS} options.`);
  }

  const unique = new Set(options.map((option) => option.toLowerCase()));
  if (unique.size !== options.length) {
    throw badRequest("Poll options must be unique.");
  }

  return options;
}

async function listPolls() {
  const result = await query(`
    ${POLL_SELECT}
    GROUP BY polls.id, users.global_name, users.username, poll_options.id
    ORDER BY polls.created_at DESC, poll_options.sort_order ASC, poll_options.created_at ASC
  `);

  const polls = [];
  const byId = new Map();

  for (const row of result.rows) {
    let poll = byId.get(row.id);
    if (!poll) {
      poll = mapPoll([row]);
      byId.set(row.id, poll);
      polls.push(poll);
      continue;
    }

    if (row.option_id && !poll.options.some((option) => option.id === row.option_id)) {
      poll.options.push({
        id: row.option_id,
        label: row.label,
        sortOrder: row.sort_order,
        votes: Number(row.vote_count || 0),
      });
    }
  }

  return polls;
}

async function createPoll({ question, options, createdBy }) {
  const cleanedQuestion = String(question || "").trim().slice(0, MAX_QUESTION_LENGTH);
  if (!cleanedQuestion) {
    throw badRequest("A poll question is required.");
  }

  const cleanedOptions = cleanOptions(options);
  const client = await getPool().connect();

  try {
    await client.query("BEGIN");

    const pollResult = await client.query(
      `
        INSERT INTO polls (question, created_by)
        VALUES ($1, $2)
        RETURNING id
      `,
      [cleanedQuestion, createdBy || null],
    );

    const pollId = pollResult.rows[0].id;

    for (const [index, label] of cleanedOptions.entries()) {
      await client.query(
        `
          INSERT INTO poll_options (poll_id, label, sort_order)
          VALUES ($1, $2, $3)
        `,
        [pollId, label, index],
      );
    }

    await client.query("COMMIT");
    return getPollById(pollId);
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

module.exports = {
  listPolls,
  createPoll,
  getPollById,
  MIN_OPTIONS,
  MAX_OPTIONS,
};

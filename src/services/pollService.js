const { getPool, query } = require("../db/pool");

const MIN_OPTIONS = 2;
const MAX_OPTIONS = 10;
const MAX_QUESTION_LENGTH = 300;
const MAX_OPTION_LENGTH = 100;

function badRequest(message, statusCode = 400) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function withViewerVotes(poll, votedOptionIds = []) {
  if (!poll) return null;

  return {
    ...poll,
    votedOptionIds,
    votedOptionId: votedOptionIds[0] || null,
    hasVoted: votedOptionIds.length > 0,
  };
}

function mapPoll(rows, votedOptionIds = []) {
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

  return withViewerVotes({
    id: first.id,
    question: first.question,
    allowMultiple: Boolean(first.allow_multiple),
    endsAt: first.ends_at,
    createdAt: first.created_at,
    author: first.author_name || "",
    options,
  }, votedOptionIds);
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

async function getViewerVotes(userId) {
  const votes = new Map();
  if (!userId) return votes;

  const result = await query(
    `
      SELECT poll_id, option_id
      FROM poll_votes
      WHERE user_id = $1
    `,
    [userId],
  );

  for (const row of result.rows) {
    const current = votes.get(row.poll_id) || [];
    current.push(row.option_id);
    votes.set(row.poll_id, current);
  }

  return votes;
}

async function getPollById(id, userId = null) {
  const result = await query(
    `
      ${POLL_SELECT}
      WHERE polls.id = $1
      GROUP BY polls.id, users.global_name, users.username, poll_options.id
      ORDER BY poll_options.sort_order ASC, poll_options.created_at ASC
    `,
    [id],
  );

  const votes = await getViewerVotes(userId);
  return mapPoll(result.rows, votes.get(id) || []);
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

async function listPolls(userId) {
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

  const votes = await getViewerVotes(userId);
  return polls.map((poll) => withViewerVotes(poll, votes.get(poll.id) || []));
}

async function createPoll({ question, options, allowMultiple, createdBy }) {
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
        INSERT INTO polls (question, allow_multiple, created_by)
        VALUES ($1, $2, $3)
        RETURNING id
      `,
      [cleanedQuestion, Boolean(allowMultiple), createdBy || null],
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
    return getPollById(pollId, createdBy || null);
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function voteOnPoll({ pollId, optionIds, userId, discordUserId }) {
  if (!userId) {
    throw badRequest("Sign in with Discord to vote.", 401);
  }

  const selectedIds = [...new Set(
    (Array.isArray(optionIds) ? optionIds : [optionIds])
      .map((id) => String(id || "").trim())
      .filter(Boolean),
  )];

  if (!pollId || selectedIds.length === 0) {
    throw badRequest("Select at least one option to vote.");
  }

  const pollResult = await query(
    `
      SELECT id, allow_multiple, ends_at
      FROM polls
      WHERE id = $1
    `,
    [pollId],
  );
  const poll = pollResult.rows[0];

  if (!poll) {
    throw badRequest("This poll could not be found.", 404);
  }

  if (poll.ends_at && new Date(poll.ends_at).getTime() <= Date.now()) {
    throw badRequest("This poll is closed.");
  }

  if (!poll.allow_multiple && selectedIds.length > 1) {
    throw badRequest("This poll only allows one answer.");
  }

  const optionResult = await query(
    `
      SELECT id
      FROM poll_options
      WHERE poll_id = $1 AND id = ANY($2::uuid[])
    `,
    [pollId, selectedIds],
  );

  if (optionResult.rows.length !== selectedIds.length) {
    throw badRequest("One or more options are not part of this poll.", 404);
  }

  const existing = await query(
    `
      SELECT id
      FROM poll_votes
      WHERE poll_id = $1 AND user_id = $2
      LIMIT 1
    `,
    [pollId, userId],
  );

  if (existing.rows[0]) {
    throw badRequest("Remove your current vote before voting again.", 409);
  }

  const client = await getPool().connect();

  try {
    await client.query("BEGIN");

    for (const optionId of selectedIds) {
      await client.query(
        `
          INSERT INTO poll_votes (poll_id, option_id, user_id, discord_user_id)
          VALUES ($1, $2, $3, $4)
        `,
        [pollId, optionId, userId, discordUserId || null],
      );
    }

    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    if (error.code === "23505") {
      throw badRequest("You have already voted on this poll.", 409);
    }
    throw error;
  } finally {
    client.release();
  }

  return getPollById(pollId, userId);
}

async function removePollVotes({ pollId, userId }) {
  if (!userId) {
    throw badRequest("Sign in with Discord to remove a vote.", 401);
  }

  if (!pollId) {
    throw badRequest("A poll is required.");
  }

  const result = await query(
    `
      DELETE FROM poll_votes
      WHERE poll_id = $1 AND user_id = $2
      RETURNING id
    `,
    [pollId, userId],
  );

  if (result.rowCount === 0) {
    throw badRequest("You have not voted on this poll.", 404);
  }

  return getPollById(pollId, userId);
}

async function getPollVoters(pollId) {
  const poll = await getPollById(pollId);
  if (!poll) {
    throw badRequest("This poll could not be found.", 404);
  }

  const result = await query(
    `
      SELECT
        poll_votes.option_id,
        users.discord_id,
        users.username,
        users.global_name,
        users.avatar
      FROM poll_votes
      JOIN users ON users.id = poll_votes.user_id
      WHERE poll_votes.poll_id = $1
      ORDER BY poll_votes.created_at ASC, users.username ASC
    `,
    [pollId],
  );

  const votersByOption = new Map();
  for (const row of result.rows) {
    const voters = votersByOption.get(row.option_id) || [];
    voters.push({
      discordId: row.discord_id,
      username: row.username,
      globalName: row.global_name || row.username,
      avatar: row.avatar || "",
    });
    votersByOption.set(row.option_id, voters);
  }

  return {
    id: poll.id,
    question: poll.question,
    options: poll.options.map((option) => ({
      ...option,
      voters: votersByOption.get(option.id) || [],
    })),
  };
}

module.exports = {
  listPolls,
  createPoll,
  getPollById,
  voteOnPoll,
  removePollVotes,
  getPollVoters,
  MIN_OPTIONS,
  MAX_OPTIONS,
};

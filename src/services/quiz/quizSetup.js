/** Validation for the pieces a host chooses when creating a quiz night. Pure, no I/O. */

const { QUESTION_TYPES } = require("../triviaValidation");

const MAX_ROUNDS = 20;
const MAX_PER_ROUND = 50;
const TITLE_MAX = 80;

const TYPE_LABELS = {
  true_false: "True / False",
  single_choice: "One option",
  multi_select: "Multi select",
  number: "Number guess",
  sort: "Sort",
  image: "Image",
  audio: "Audio",
  video: "Video",
};

function typeLabel(type) {
  return TYPE_LABELS[type] || type;
}

class QuizSetupError extends Error {
  constructor(message, fields) {
    super(message);
    this.statusCode = 400;
    if (fields) this.fields = fields;
  }
}

function clampInt(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, Math.round(number)));
}

/**
 * Turns the host's chosen rounds into `[{ type, count }]`.
 * `available` maps question type -> number of ready questions.
 */
function normalizeRounds(raw, available) {
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new QuizSetupError("Add at least one round.", { rounds: "Add at least one round." });
  }
  if (raw.length > MAX_ROUNDS) {
    throw new QuizSetupError(`Use at most ${MAX_ROUNDS} rounds.`, { rounds: `Use at most ${MAX_ROUNDS} rounds.` });
  }

  const fields = {};
  const seen = new Set();
  const rounds = raw.map((round, index) => {
    const type = typeof round?.type === "string" ? round.type.trim() : "";
    const count = Number(round?.count);

    if (!type) {
      fields[`rounds[${index}].type`] = "Pick a question type.";
    } else if (!QUESTION_TYPES.includes(type)) {
      fields[`rounds[${index}].type`] = "That is not a question type.";
    } else if (seen.has(type)) {
      fields[`rounds[${index}].type`] = "Each type can only be used once.";
    } else if (!available.has(type)) {
      fields[`rounds[${index}].type`] = "That type has no ready questions.";
    }
    if (type) seen.add(type);

    if (!Number.isInteger(count) || count < 1 || count > MAX_PER_ROUND) {
      fields[`rounds[${index}].count`] = `Choose 1 to ${MAX_PER_ROUND} questions.`;
    } else if (available.has(type) && count > available.get(type)) {
      fields[`rounds[${index}].count`] = `Only ${available.get(type)} ready question(s) of this type.`;
    }

    return { type, count };
  });

  if (Object.keys(fields).length > 0) {
    throw new QuizSetupError("One or more rounds are not valid.", fields);
  }
  return rounds;
}

/** Clamps host-supplied settings to safe values; anything missing keeps its default. */
function normalizeSettings(raw = {}) {
  const input = raw && typeof raw === "object" ? raw : {};
  return {
    introMs: clampInt(input.introSeconds, 2, 10, 3) * 1000,
    revealMs: clampInt(input.revealSeconds, 3, 30, 8) * 1000,
    leaderboardMs: clampInt(input.leaderboardSeconds, 3, 30, 8) * 1000,
    autoAdvance: input.autoAdvance === true,
    endWhenAllAnswered: input.endWhenAllAnswered !== false,
  };
}

function normalizeTitle(raw, fallback) {
  const title = typeof raw === "string" ? raw.trim() : "";
  const chosen = title || String(fallback || "").trim() || "Quiz night";
  return chosen.slice(0, TITLE_MAX);
}

module.exports = { QuizSetupError, TYPE_LABELS, normalizeRounds, normalizeSettings, normalizeTitle, typeLabel };

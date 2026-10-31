/** Validation for the pieces a host chooses when creating a quiz night. Pure, no I/O. */

const MAX_QUESTIONS = 50;
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
 * Host picks how many questions to take from each type. Those picks are later
 * shuffled into one mixed list, not played type-by-type.
 */
function normalizePool(raw, available) {
  const input = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  const fields = {};
  const seen = new Set();
  const types = [];

  const listed = Array.isArray(input.types) ? input.types : [];
  if (listed.length === 0) {
    fields.types = "Choose how many questions you want from at least one type.";
  }

  listed.forEach((entry, index) => {
    const type = typeof entry === "string" ? entry.trim() : typeof entry?.type === "string" ? entry.type.trim() : "";
    const count = Number(entry?.count ?? (typeof entry === "string" ? 0 : entry?.count));

    if (!type) return;
    if (seen.has(type)) {
      fields[`types[${index}].type`] = "Each type can only be used once.";
      return;
    }
    seen.add(type);

    if (!TYPE_LABELS[type]) {
      fields[`types[${index}].type`] = "That is not a question type.";
      return;
    }
    if (!available.has(type)) {
      fields[`types[${index}].type`] = `${typeLabel(type)} has no ready questions.`;
      return;
    }
    if (!Number.isInteger(count) || count < 0 || count > MAX_QUESTIONS) {
      fields[`types[${index}].count`] = `Choose 0 to ${MAX_QUESTIONS} questions.`;
      return;
    }
    if (count === 0) return;
    if (count > available.get(type)) {
      fields[`types[${index}].count`] = `Only ${available.get(type)} ready ${typeLabel(type)} question(s).`;
      return;
    }
    types.push({ type, count });
  });

  const total = types.reduce((sum, item) => sum + item.count, 0);
  if (listed.length > 0 && types.length === 0 && !fields.types && Object.keys(fields).length === 0) {
    fields.types = "Choose how many questions you want from at least one type.";
  }
  if (total > MAX_QUESTIONS) {
    fields.types = `Use at most ${MAX_QUESTIONS} questions in total.`;
  }

  if (Object.keys(fields).length > 0) {
    throw new QuizSetupError("The question pool is not valid.", fields);
  }

  return { types, count: total };
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

const DISCORD_ID = /^\d{17,20}$/;
const MAX_ALLOWED_DISCORD_IDS = 100;

/** The accounts allowed to join when a quiz is not tied to a Raid Helper event. */
function normalizeAllowedDiscordIds(raw) {
  const parts = Array.isArray(raw)
    ? raw
    : typeof raw === "string"
      ? raw.split(/[\s,;]+/)
      : [];
  const ids = [];
  const seen = new Set();
  let invalid = false;

  for (const part of parts) {
    const id = String(part || "").trim();
    if (!id) continue;
    if (!DISCORD_ID.test(id)) {
      invalid = true;
      continue;
    }
    if (!seen.has(id)) {
      seen.add(id);
      ids.push(id);
    }
  }

  if (invalid) {
    throw new QuizSetupError("Each Discord ID must be the numeric ID, 17 to 20 digits.", {
      allowedDiscordIds: "Each Discord ID must be the numeric ID, 17 to 20 digits.",
    });
  }
  if (ids.length === 0) {
    throw new QuizSetupError("Add at least one Discord ID that can join.", {
      allowedDiscordIds: "Add at least one Discord ID that can join.",
    });
  }
  if (ids.length > MAX_ALLOWED_DISCORD_IDS) {
    throw new QuizSetupError(`List at most ${MAX_ALLOWED_DISCORD_IDS} Discord IDs.`, {
      allowedDiscordIds: `List at most ${MAX_ALLOWED_DISCORD_IDS} Discord IDs.`,
    });
  }
  return ids;
}

module.exports = {
  QuizSetupError,
  TYPE_LABELS,
  normalizePool,
  normalizeSettings,
  normalizeTitle,
  normalizeAllowedDiscordIds,
  typeLabel,
};

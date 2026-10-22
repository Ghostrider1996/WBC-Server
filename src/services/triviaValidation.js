const { isTriviaKey, normalizeVideoLink } = require("./triviaMedia");

const QUESTION_TYPES = ["true_false", "single_choice", "multi_select", "number", "sort", "image", "audio", "video"];
const MEDIA_QUESTION_TYPES = ["image", "audio", "video"];
const MEDIA_FORMATS = ["single_choice", "multi_select", "true_false", "number"];
const DIFFICULTIES = ["easy", "medium", "hard"];
const STATUSES = ["draft", "ready", "archived"];
const SCORING_MODES = ["all_or_nothing", "partial"];

const LIMITS = {
  prompt: [1, 500],
  explanation: [0, 1000],
  category: [1, 40],
  tag: [1, 30],
  maxTags: 10,
  timeLimitSeconds: [5, 300],
  points: [0, 10000],
  optionText: [1, 120],
  singleChoiceOptions: [2, 6],
  multiSelectOptions: [2, 8],
  sortItem: [1, 100],
  sortItems: [2, 8],
  sortLabel: [0, 24],
  unit: [0, 16],
};

const FORMAT_KEYS = {
  true_false: ["correct"],
  single_choice: ["options"],
  multi_select: ["options", "scoring"],
  number: ["correct", "tolerance", "partialRange", "min", "max", "step", "unit"],
  sort: ["items", "startLabel", "endLabel"],
};

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function has(object, key) {
  return Object.prototype.hasOwnProperty.call(object, key) && object[key] !== undefined;
}

function charLength(text) {
  return [...text].length;
}

function isFiniteNumber(value) {
  return typeof value === "number" && Number.isFinite(value);
}

function readString(source, key, path, [min, max], fields, { defaultValue } = {}) {
  if (!has(source, key)) {
    if (defaultValue !== undefined) return defaultValue;
    fields[path] = "Required.";
    return null;
  }

  if (typeof source[key] !== "string") {
    fields[path] = "Must be a string.";
    return null;
  }

  const text = source[key].trim();
  const length = charLength(text);
  if (length < min || length > max) {
    fields[path] = min === 0
      ? `Must be at most ${max} characters.`
      : `Must be ${min}-${max} characters.`;
    return null;
  }
  return text;
}

function readEnum(source, key, path, allowed, fields, defaultValue) {
  if (!has(source, key)) {
    if (defaultValue !== undefined) return defaultValue;
    fields[path] = "Required.";
    return null;
  }

  if (typeof source[key] !== "string" || !allowed.includes(source[key])) {
    fields[path] = `Must be one of: ${allowed.join(", ")}.`;
    return null;
  }
  return source[key];
}

function readInteger(source, key, path, [min, max], fields, defaultValue) {
  if (!has(source, key)) return defaultValue;
  const value = source[key];
  if (!Number.isInteger(value) || value < min || value > max) {
    fields[path] = `Must be a whole number from ${min} to ${max}.`;
    return null;
  }
  return value;
}

function rejectUnknownKeys(source, allowed, basePath, fields, label) {
  for (const key of Object.keys(source)) {
    if (!allowed.includes(key)) {
      fields[basePath ? `${basePath}.${key}` : key] = `Not allowed for ${label}.`;
    }
  }
}

function validateTags(body, fields) {
  if (!has(body, "tags")) return [];
  if (!Array.isArray(body.tags)) {
    fields.tags = "Must be an array of strings.";
    return [];
  }

  const tags = [];
  const seen = new Set();
  body.tags.forEach((raw, index) => {
    const path = `tags[${index}]`;
    if (typeof raw !== "string") {
      fields[path] = "Must be a string.";
      return;
    }
    const tag = raw.trim().toLowerCase();
    const length = charLength(tag);
    if (length < LIMITS.tag[0] || length > LIMITS.tag[1]) {
      fields[path] = `Must be ${LIMITS.tag[0]}-${LIMITS.tag[1]} characters.`;
      return;
    }
    if (!seen.has(tag)) {
      seen.add(tag);
      tags.push(tag);
    }
  });

  if (tags.length > LIMITS.maxTags) {
    fields.tags = `At most ${LIMITS.maxTags} tags.`;
  }
  return tags;
}

function validateOptions(answer, fields, [min, max]) {
  const options = [];
  if (!Array.isArray(answer.options)) {
    fields["answer.options"] = "Must be an array of options.";
    return options;
  }

  if (answer.options.length < min || answer.options.length > max) {
    fields["answer.options"] = `Must have ${min}-${max} options.`;
  }

  const seen = new Set();
  answer.options.forEach((raw, index) => {
    const base = `answer.options[${index}]`;
    if (!isPlainObject(raw)) {
      fields[base] = "Must be an object with text and correct.";
      return;
    }

    rejectUnknownKeys(raw, ["text", "correct"], base, fields, "an option");
    const text = readString(raw, "text", `${base}.text`, LIMITS.optionText, fields);
    let correct = false;
    if (typeof raw.correct !== "boolean") {
      fields[`${base}.correct`] = "Must be true or false.";
    } else {
      correct = raw.correct;
    }

    if (text !== null) {
      const folded = text.toLowerCase();
      if (seen.has(folded)) {
        fields[`${base}.text`] = "Options must be unique.";
      }
      seen.add(folded);
    }
    options.push({ text: text ?? "", correct });
  });

  return options;
}

function validateTrueFalse(answer, fields) {
  if (typeof answer.correct !== "boolean") {
    fields["answer.correct"] = "Must be true or false.";
    return null;
  }
  return { correct: answer.correct };
}

function validateSingleChoice(answer, fields) {
  const options = validateOptions(answer, fields, LIMITS.singleChoiceOptions);
  if (!fields["answer.options"] && options.filter((option) => option.correct).length !== 1) {
    fields["answer.options"] = "Exactly one option must be correct.";
  }
  return { options };
}

function validateMultiSelect(answer, fields) {
  const options = validateOptions(answer, fields, LIMITS.multiSelectOptions);
  const correctCount = options.filter((option) => option.correct).length;
  if (!fields["answer.options"]) {
    if (correctCount < 1) {
      fields["answer.options"] = "At least one option must be correct.";
    } else if (correctCount === options.length) {
      fields["answer.options"] = "At least one option must be incorrect.";
    }
  }
  const scoring = readEnum(answer, "scoring", "answer.scoring", SCORING_MODES, fields, "all_or_nothing");
  return { options, scoring };
}

function validateNumber(answer, fields) {
  const readNumber = (key) => {
    if (!has(answer, key)) {
      fields[`answer.${key}`] = "Required.";
      return null;
    }
    if (!isFiniteNumber(answer[key])) {
      fields[`answer.${key}`] = "Must be a finite number.";
      return null;
    }
    return answer[key];
  };

  const correct = readNumber("correct");
  const min = readNumber("min");
  const max = readNumber("max");

  if (min !== null && max !== null && min >= max) {
    fields["answer.max"] = "Must be greater than min.";
  }
  if (correct !== null && min !== null && correct < min) {
    fields["answer.correct"] = "Must be at least min.";
  }
  if (correct !== null && max !== null && correct > max) {
    fields["answer.correct"] = "Must be at most max.";
  }

  let tolerance = 0;
  if (has(answer, "tolerance")) {
    if (!isFiniteNumber(answer.tolerance) || answer.tolerance < 0) {
      fields["answer.tolerance"] = "Must be a number of 0 or more.";
    } else {
      tolerance = answer.tolerance;
    }
  }

  let partialRange = null;
  if (has(answer, "partialRange") && answer.partialRange !== null) {
    if (!isFiniteNumber(answer.partialRange)) {
      fields["answer.partialRange"] = "Must be a number or null.";
    } else if (answer.partialRange < tolerance) {
      fields["answer.partialRange"] = "Must be at least the tolerance.";
    } else {
      partialRange = answer.partialRange;
    }
  }

  let step = 1;
  if (has(answer, "step")) {
    if (!isFiniteNumber(answer.step) || answer.step <= 0) {
      fields["answer.step"] = "Must be greater than 0.";
    } else {
      step = answer.step;
    }
  }
  if (!fields["answer.step"] && !fields["answer.max"] && min !== null && max !== null && max - min < step) {
    fields["answer.step"] = "Must not be larger than the range (max - min).";
  }

  const unit = readString(answer, "unit", "answer.unit", LIMITS.unit, fields, { defaultValue: "" });

  return { correct, tolerance, partialRange, min, max, step, unit: unit ?? "" };
}

function validateSort(answer, fields) {
  const items = [];
  if (!Array.isArray(answer.items)) {
    fields["answer.items"] = "Must be an array of strings.";
  } else {
    if (answer.items.length < LIMITS.sortItems[0] || answer.items.length > LIMITS.sortItems[1]) {
      fields["answer.items"] = `Must have ${LIMITS.sortItems[0]}-${LIMITS.sortItems[1]} items.`;
    }
    const seen = new Set();
    answer.items.forEach((raw, index) => {
      const path = `answer.items[${index}]`;
      if (typeof raw !== "string") {
        fields[path] = "Must be a string.";
        return;
      }
      const text = raw.trim();
      const length = charLength(text);
      if (length < LIMITS.sortItem[0] || length > LIMITS.sortItem[1]) {
        fields[path] = `Must be ${LIMITS.sortItem[0]}-${LIMITS.sortItem[1]} characters.`;
        return;
      }
      const folded = text.toLowerCase();
      if (seen.has(folded)) {
        fields[path] = "Items must be unique.";
      }
      seen.add(folded);
      items.push(text);
    });
  }

  const startLabel = readString(answer, "startLabel", "answer.startLabel", LIMITS.sortLabel, fields, { defaultValue: "" });
  const endLabel = readString(answer, "endLabel", "answer.endLabel", LIMITS.sortLabel, fields, { defaultValue: "" });
  return { items, startLabel: startLabel ?? "", endLabel: endLabel ?? "" };
}

const FORMAT_VALIDATORS = {
  true_false: validateTrueFalse,
  single_choice: validateSingleChoice,
  multi_select: validateMultiSelect,
  number: validateNumber,
  sort: validateSort,
};

function validateAnswer(type, rawAnswer, fields) {
  if (!isPlainObject(rawAnswer)) {
    fields.answer = rawAnswer === undefined ? "Required." : "Must be an object.";
    return null;
  }

  const isMediaType = MEDIA_QUESTION_TYPES.includes(type);
  let format = type;
  let allowedKeys = FORMAT_KEYS[type];

  if (isMediaType) {
    format = readEnum(rawAnswer, "format", "answer.format", MEDIA_FORMATS, fields);
    allowedKeys = ["format", ...(FORMAT_KEYS[format] || [])];
  }

  rejectUnknownKeys(rawAnswer, allowedKeys || [], "answer", fields, `${type} answers`);
  if (!format) return null;

  const body = FORMAT_VALIDATORS[format](rawAnswer, fields);
  if (!body) return null;
  return isMediaType ? { format, ...body } : body;
}

function validateClip(source, kind, fields) {
  const hasStart = has(source, "startSeconds") && source.startSeconds !== null;
  const hasEnd = has(source, "endSeconds") && source.endSeconds !== null;

  if (kind === "image") {
    if (hasStart) fields["media.startSeconds"] = "Only valid for audio and video.";
    if (hasEnd) fields["media.endSeconds"] = "Only valid for audio and video.";
    return {};
  }

  let startSeconds = 0;
  if (hasStart) {
    if (!isFiniteNumber(source.startSeconds) || source.startSeconds < 0) {
      fields["media.startSeconds"] = "Must be a number of 0 or more.";
    } else {
      startSeconds = source.startSeconds;
    }
  }

  let endSeconds = null;
  if (hasEnd) {
    if (!isFiniteNumber(source.endSeconds)) {
      fields["media.endSeconds"] = "Must be a number.";
    } else if (source.endSeconds <= startSeconds) {
      fields["media.endSeconds"] = "Must be greater than startSeconds.";
    } else {
      endSeconds = source.endSeconds;
    }
  }

  return { startSeconds, endSeconds };
}

function validateMedia(type, rawMedia, fields) {
  const isMediaType = MEDIA_QUESTION_TYPES.includes(type);

  if (rawMedia === undefined || rawMedia === null) {
    if (isMediaType) fields.media = `Required for ${type} questions.`;
    return null;
  }

  if (!isMediaType) {
    fields.media = `Must be null for ${type} questions.`;
    return null;
  }

  if (!isPlainObject(rawMedia)) {
    fields.media = "Must be an object.";
    return null;
  }

  const kind = readEnum(rawMedia, "kind", "media.kind", MEDIA_QUESTION_TYPES, fields);
  if (kind && kind !== type) {
    fields["media.kind"] = `Must be "${type}" for ${type} questions.`;
  }

  const source = readEnum(rawMedia, "source", "media.source", ["upload", "url"], fields);
  if (!kind || !source) return null;

  const media = { kind, source };

  if (source === "upload") {
    if (has(rawMedia, "sourceUrl") && rawMedia.sourceUrl !== null && rawMedia.sourceUrl !== "") {
      fields["media.sourceUrl"] = "Not allowed when source is upload.";
    }
    if (!has(rawMedia, "key")) {
      fields["media.key"] = "Required when source is upload.";
    } else if (!isTriviaKey(rawMedia.key)) {
      fields["media.key"] = "Must be a key returned by the media upload (trivia/<name>).";
    } else {
      media.key = rawMedia.key;
    }
  } else {
    if (kind !== "video") {
      fields["media.source"] = "Links are only supported for video.";
    }
    if (has(rawMedia, "key") && rawMedia.key !== null && rawMedia.key !== "") {
      fields["media.key"] = "Not allowed when source is url.";
    }
    if (!has(rawMedia, "sourceUrl")) {
      fields["media.sourceUrl"] = "Required when source is url.";
    } else if (typeof rawMedia.sourceUrl !== "string" || !normalizeVideoLink(rawMedia.sourceUrl)) {
      fields["media.sourceUrl"] = "Use a YouTube or Vimeo link, or a direct https .mp4/.webm link.";
    } else {
      media.sourceUrl = rawMedia.sourceUrl.trim();
    }
  }

  Object.assign(media, validateClip(rawMedia, kind, fields));
  return media;
}

/**
 * Validate and normalize a question request body.
 * Returns { value, fields }; `value` is null whenever `fields` has entries.
 */
function validateQuestionInput(body) {
  const fields = {};
  if (!isPlainObject(body)) {
    return { value: null, fields: { body: "Must be a JSON object." } };
  }

  const type = readEnum(body, "type", "type", QUESTION_TYPES, fields);
  const prompt = readString(body, "prompt", "prompt", LIMITS.prompt, fields);
  const explanation = readString(body, "explanation", "explanation", LIMITS.explanation, fields, { defaultValue: "" });
  const category = readString(body, "category", "category", LIMITS.category, fields);
  const tags = validateTags(body, fields);
  const difficulty = readEnum(body, "difficulty", "difficulty", DIFFICULTIES, fields, "medium");
  const timeLimitSeconds = readInteger(body, "timeLimitSeconds", "timeLimitSeconds", LIMITS.timeLimitSeconds, fields, 20);
  const points = readInteger(body, "points", "points", LIMITS.points, fields, 1000);
  const status = readEnum(body, "status", "status", STATUSES, fields, "draft");

  let media = null;
  let answer = null;
  if (type) {
    media = validateMedia(type, body.media, fields);
    answer = validateAnswer(type, body.answer, fields);
  }

  if (Object.keys(fields).length > 0) {
    return { value: null, fields };
  }

  return {
    value: {
      type,
      prompt,
      explanation,
      category,
      tags,
      difficulty,
      timeLimitSeconds,
      points,
      status,
      media,
      answer,
    },
    fields: {},
  };
}

module.exports = {
  DIFFICULTIES,
  LIMITS,
  MEDIA_FORMATS,
  QUESTION_TYPES,
  STATUSES,
  isPlainObject,
  validateQuestionInput,
};

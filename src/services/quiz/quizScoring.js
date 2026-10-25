/**
 * Pure quiz helpers: turning a stored trivia question into the version players
 * may see, grading a response, and turning a grade into points.
 *
 * Stored answers hold the solution, so nothing here that is sent to players may
 * read `correct` flags, number answers or sort order back out to them.
 */

const MEDIA_TYPES = new Set(["image", "audio", "video"]);

/** Share of the question's points a correct answer always keeps, however slow. */
const MIN_SPEED_SHARE = 0.5;
/** Credit given at the very edge of a number question's tolerance when a partial range is set. */
const NUMBER_PARTIAL_CEILING = 0.5;

function answerFormat(question) {
  return MEDIA_TYPES.has(question.type) ? question.answer?.format : question.type;
}

function shuffled(items, random = Math.random) {
  const copy = [...items];
  for (let index = copy.length - 1; index > 0; index -= 1) {
    const swap = Math.floor(random() * (index + 1));
    [copy[index], copy[swap]] = [copy[swap], copy[index]];
  }
  return copy;
}

/**
 * The question as players see it. Choice options and sort items keep their
 * stored index as an opaque id and are shuffled, so the order never hints.
 */
function toPlayerQuestion(question, { random = Math.random } = {}) {
  const format = answerFormat(question);
  const answer = question.answer || {};

  const view = {
    id: question.id,
    type: question.type,
    format,
    prompt: question.prompt,
    category: question.category,
    difficulty: question.difficulty,
    timeLimitSeconds: question.timeLimitSeconds,
    points: question.points,
    media: question.media || null,
  };

  if (format === "single_choice" || format === "multi_select") {
    view.options = shuffled(
      (answer.options || []).map((option, id) => ({ id, text: option.text })),
      random,
    );
    if (format === "multi_select") view.partialCredit = answer.scoring === "partial";
  } else if (format === "number") {
    view.number = { min: answer.min, max: answer.max, step: answer.step, unit: answer.unit || "" };
  } else if (format === "sort") {
    view.items = shuffled((answer.items || []).map((text, id) => ({ id, text })), random);
    view.startLabel = answer.startLabel || "";
    view.endLabel = answer.endLabel || "";
  }

  return view;
}

/** What is revealed once a question is locked: the solution, in the shape the client renders. */
function toReveal(question) {
  const format = answerFormat(question);
  const answer = question.answer || {};
  const reveal = { format, explanation: question.explanation || "" };

  if (format === "true_false") {
    reveal.correct = Boolean(answer.correct);
  } else if (format === "single_choice" || format === "multi_select") {
    reveal.correctIds = (answer.options || [])
      .map((option, id) => (option.correct ? id : -1))
      .filter((id) => id >= 0);
    reveal.options = (answer.options || []).map((option, id) => ({ id, text: option.text }));
  } else if (format === "number") {
    reveal.correct = answer.correct;
    reveal.tolerance = answer.tolerance || 0;
    reveal.unit = answer.unit || "";
  } else if (format === "sort") {
    reveal.items = (answer.items || []).map((text, id) => ({ id, text }));
    reveal.correctOrder = (answer.items || []).map((_, id) => id);
  }

  return reveal;
}

function uniqueIds(response, size) {
  if (!Array.isArray(response) || response.length > size) return null;
  const seen = new Set();
  for (const value of response) {
    if (!Number.isInteger(value) || value < 0 || value >= size || seen.has(value)) return null;
    seen.add(value);
  }
  return [...seen];
}

/**
 * Checks a raw client response is well formed for the question and returns the
 * cleaned version, or null when it is not. Nothing here depends on correctness.
 */
function normalizeResponse(question, response) {
  const format = answerFormat(question);
  const answer = question.answer || {};

  if (format === "true_false") return typeof response === "boolean" ? response : null;

  if (format === "single_choice") {
    const size = (answer.options || []).length;
    return Number.isInteger(response) && response >= 0 && response < size ? response : null;
  }

  if (format === "multi_select") {
    const ids = uniqueIds(response, (answer.options || []).length);
    return ids && ids.length > 0 ? ids.sort((a, b) => a - b) : null;
  }

  if (format === "number") {
    if (typeof response !== "number" || !Number.isFinite(response)) return null;
    return response >= answer.min && response <= answer.max ? response : null;
  }

  if (format === "sort") {
    const size = (answer.items || []).length;
    const ids = uniqueIds(response, size);
    return ids && ids.length === size ? response : null;
  }

  return null;
}

/**
 * Grades an already normalised response.
 * Returns `{ fraction, verdict }`: fraction is 0..1 of the points available
 * before the speed adjustment, verdict is "correct", "partial" or "wrong".
 */
function gradeResponse(question, response) {
  const format = answerFormat(question);
  const answer = question.answer || {};

  const result = (fraction) => ({
    fraction,
    verdict: fraction >= 1 ? "correct" : fraction > 0 ? "partial" : "wrong",
  });

  if (format === "true_false") return result(response === Boolean(answer.correct) ? 1 : 0);

  if (format === "single_choice") return result(answer.options?.[response]?.correct ? 1 : 0);

  if (format === "multi_select") {
    const options = answer.options || [];
    const correctIds = options.map((option, id) => (option.correct ? id : -1)).filter((id) => id >= 0);
    const chosen = new Set(response);
    const hits = correctIds.filter((id) => chosen.has(id)).length;
    const misses = chosen.size - hits;
    if (hits === correctIds.length && misses === 0) return result(1);
    if (answer.scoring !== "partial" || correctIds.length === 0) return result(0);
    return result(Math.max(0, (hits - misses) / correctIds.length));
  }

  if (format === "number") {
    const difference = Math.abs(response - answer.correct);
    const tolerance = answer.tolerance || 0;
    if (difference <= tolerance) return result(1);
    const range = answer.partialRange;
    if (range === null || range === undefined || range <= tolerance || difference > range) return result(0);
    return result(NUMBER_PARTIAL_CEILING * (1 - (difference - tolerance) / (range - tolerance)));
  }

  if (format === "sort") {
    const size = (answer.items || []).length;
    if (size === 0) return result(0);
    const inPlace = response.filter((id, position) => id === position).length;
    return result(inPlace / size);
  }

  return result(0);
}

/**
 * Points for a grade: the question's points, scaled by how right the response was
 * and by how quickly it arrived (a correct answer at the buzzer keeps half).
 */
function pointsFor(question, fraction, remainingMs, totalMs) {
  if (!(fraction > 0)) return 0;
  const share = totalMs > 0 ? Math.min(1, Math.max(0, remainingMs / totalMs)) : 0;
  const speed = MIN_SPEED_SHARE + (1 - MIN_SPEED_SHARE) * share;
  return Math.round(question.points * fraction * speed);
}

module.exports = {
  answerFormat,
  gradeResponse,
  normalizeResponse,
  pointsFor,
  shuffled,
  toPlayerQuestion,
  toReveal,
};

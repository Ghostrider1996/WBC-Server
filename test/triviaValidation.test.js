const test = require("node:test");
const assert = require("node:assert/strict");
const { validateQuestionInput } = require("../src/services/triviaValidation");

function base(overrides = {}) {
  return { prompt: "Who is the Lich King?", category: "WoW lore", ...overrides };
}

const options = (...entries) => entries.map(([text, correct]) => ({ text, correct }));

const examples = {
  true_false: base({ type: "true_false", answer: { correct: true } }),
  single_choice: base({
    type: "single_choice",
    answer: { options: options(["Illidan", true], ["Arthas", false]) },
  }),
  multi_select: base({
    type: "multi_select",
    answer: { options: options(["Karazhan", true], ["Naxxramas", false]), scoring: "partial" },
  }),
  number: base({
    type: "number",
    answer: { correct: 70, tolerance: 0, partialRange: 20, min: 0, max: 100, step: 1, unit: "levels" },
  }),
  sort: base({
    type: "sort",
    answer: { items: ["Vanilla", "The Burning Crusade", "Wrath of the Lich King"], startLabel: "Oldest", endLabel: "Newest" },
  }),
  image: base({
    type: "image",
    media: { kind: "image", source: "upload", key: "trivia/2f8f2f6e-0f3c-4f7a-bf0e-0a1b2c3d4e5f.png" },
    answer: { format: "single_choice", options: options(["Stormwind", true], ["Ironforge", false]) },
  }),
  audio: base({
    type: "audio",
    media: { kind: "audio", source: "upload", key: "trivia/abc.mp3", startSeconds: 5, endSeconds: 15 },
    answer: { format: "true_false", correct: false },
  }),
  video: base({
    type: "video",
    media: { kind: "video", source: "url", sourceUrl: "https://youtu.be/dQw4w9WgXcQ" },
    answer: { format: "number", correct: 5, min: 0, max: 10 },
  }),
};

function fieldsOf(body) {
  const result = validateQuestionInput(body);
  assert.equal(result.value, null, "expected the body to be rejected");
  return result.fields;
}

for (const [type, body] of Object.entries(examples)) {
  test(`${type}: valid example is accepted and defaults are applied`, () => {
    const { value, fields } = validateQuestionInput(body);
    assert.deepEqual(fields, {});
    assert.equal(value.type, type);
    assert.equal(value.explanation, "");
    assert.deepEqual(value.tags, []);
    assert.equal(value.difficulty, "medium");
    assert.equal(value.timeLimitSeconds, 20);
    assert.equal(value.points, 1000);
    assert.equal(value.status, "draft");
  });
}

test("normalized output is stable when re-validated (round trip)", () => {
  for (const body of Object.values(examples)) {
    const first = validateQuestionInput(body).value;
    const second = validateQuestionInput({ ...first, id: "x", createdAt: "y", media: first.media && { ...first.media, url: "https://signed", expiresAt: null } });
    assert.deepEqual(second.value, first);
  }
});

test("non-object bodies are rejected", () => {
  assert.deepEqual(validateQuestionInput(null).fields, { body: "Must be a JSON object." });
  assert.deepEqual(validateQuestionInput([]).fields, { body: "Must be a JSON object." });
});

test("common fields: trimming, tags, enums and ranges", () => {
  const { value } = validateQuestionInput({
    ...examples.true_false,
    prompt: "  Trim me  ",
    category: " Lore ",
    explanation: " why ",
    tags: [" Raid ", "raid", "PvP"],
    difficulty: "hard",
    timeLimitSeconds: 300,
    points: 0,
    status: "ready",
  });
  assert.equal(value.prompt, "Trim me");
  assert.equal(value.category, "Lore");
  assert.equal(value.explanation, "why");
  assert.deepEqual(value.tags, ["raid", "pvp"]);
  assert.equal(value.status, "ready");

  const fields = fieldsOf({
    ...examples.true_false,
    prompt: "   ",
    category: "x".repeat(41),
    explanation: "x".repeat(1001),
    tags: ["ok", "", "y".repeat(31), 5],
    difficulty: "brutal",
    timeLimitSeconds: 4,
    points: 10001,
    status: "published",
  });
  for (const key of ["prompt", "category", "explanation", "tags[1]", "tags[2]", "tags[3]", "difficulty", "timeLimitSeconds", "points", "status"]) {
    assert.ok(fields[key], `missing error for ${key}`);
  }

  assert.ok(fieldsOf({ ...examples.true_false, tags: Array.from({ length: 11 }, (_, i) => `t${i}`) }).tags);
  assert.ok(fieldsOf({ ...examples.true_false, timeLimitSeconds: 20.5 }).timeLimitSeconds);
  assert.ok(fieldsOf({ ...examples.true_false, prompt: "x".repeat(501) }).prompt);
  assert.ok(fieldsOf({ ...examples.true_false, type: "essay" }).type);
});

test("missing type, prompt, category and answer are reported", () => {
  const fields = fieldsOf({});
  assert.ok(fields.type && fields.prompt && fields.category);
  assert.ok(fieldsOf({ type: "true_false", prompt: "p", category: "c" }).answer);
});

test("true_false: correct must be boolean and extra fields are rejected", () => {
  assert.ok(fieldsOf({ ...examples.true_false, answer: { correct: "yes" } })["answer.correct"]);
  assert.ok(fieldsOf({ ...examples.true_false, answer: { correct: true, options: [] } })["answer.options"]);
  assert.ok(fieldsOf({ ...examples.true_false, answer: { correct: true, format: "true_false" } })["answer.format"]);
  assert.ok(fieldsOf({ ...examples.true_false, media: examples.image.media }).media);
});

test("single_choice: zero or two correct options are rejected", () => {
  const zero = fieldsOf({ ...examples.single_choice, answer: { options: options(["A", false], ["B", false]) } });
  assert.match(zero["answer.options"], /Exactly one/);
  const two = fieldsOf({ ...examples.single_choice, answer: { options: options(["A", true], ["B", true]) } });
  assert.match(two["answer.options"], /Exactly one/);
});

test("single_choice: option count, text length, duplicates and shape", () => {
  assert.ok(fieldsOf({ ...examples.single_choice, answer: { options: options(["A", true]) } })["answer.options"]);
  const seven = Array.from({ length: 7 }, (_, i) => [`o${i}`, i === 0]);
  assert.ok(fieldsOf({ ...examples.single_choice, answer: { options: options(...seven) } })["answer.options"]);

  const fields = fieldsOf({
    ...examples.single_choice,
    answer: { options: options(["Same", true], ["Other", false], ["same ", false], ["", false], ["x".repeat(121), false]) },
  });
  assert.ok(fields["answer.options[2].text"], "case-insensitive duplicate");
  assert.ok(fields["answer.options[3].text"], "empty text");
  assert.ok(fields["answer.options[4].text"], "long text");

  const shape = fieldsOf({
    ...examples.single_choice,
    answer: { options: [{ text: "A", correct: true, extra: 1 }, { text: "B", correct: "no" }] },
  });
  assert.ok(shape["answer.options[0].extra"]);
  assert.ok(shape["answer.options[1].correct"]);
  assert.ok(fieldsOf({ ...examples.single_choice, answer: { options: "nope" } })["answer.options"]);
  assert.ok(fieldsOf({ ...examples.single_choice, answer: { options: options(["A", true], ["B", false]), scoring: "partial" } })["answer.scoring"]);
});

test("multi_select: needs at least one correct and one incorrect option", () => {
  assert.match(
    fieldsOf({ ...examples.multi_select, answer: { options: options(["A", false], ["B", false]) } })["answer.options"],
    /At least one option must be correct/,
  );
  assert.match(
    fieldsOf({ ...examples.multi_select, answer: { options: options(["A", true], ["B", true]) } })["answer.options"],
    /At least one option must be incorrect/,
  );
  const nine = Array.from({ length: 9 }, (_, i) => [`o${i}`, i === 0]);
  assert.ok(fieldsOf({ ...examples.multi_select, answer: { options: options(...nine) } })["answer.options"]);
  assert.ok(fieldsOf({ ...examples.multi_select, answer: { options: options(["A", true], ["B", false]), scoring: "half" } })["answer.scoring"]);

  const { value } = validateQuestionInput({ ...examples.multi_select, answer: { options: options(["A", true], ["B", false], ["C", true]) } });
  assert.equal(value.answer.scoring, "all_or_nothing");
});

test("number: min/max/correct/tolerance/partialRange/step rules", () => {
  const number = (answer) => ({ ...examples.number, answer: { ...examples.number.answer, ...answer } });

  assert.ok(fieldsOf(number({ min: 100, max: 100, correct: 100 }))["answer.max"]);
  assert.ok(fieldsOf(number({ min: 50, max: 10 }))["answer.max"]);
  assert.ok(fieldsOf(number({ correct: -1 }))["answer.correct"]);
  assert.ok(fieldsOf(number({ correct: 101 }))["answer.correct"]);
  assert.ok(fieldsOf(number({ correct: "70" }))["answer.correct"]);
  assert.ok(fieldsOf(number({ tolerance: -1 }))["answer.tolerance"]);
  assert.ok(fieldsOf(number({ tolerance: 5, partialRange: 4 }))["answer.partialRange"]);
  assert.ok(fieldsOf(number({ step: 0 }))["answer.step"]);
  assert.ok(fieldsOf(number({ step: 101 }))["answer.step"]);
  assert.ok(fieldsOf(number({ unit: "x".repeat(17) }))["answer.unit"]);
  assert.ok(fieldsOf(number({ bogus: 1 }))["answer.bogus"]);
  const missing = fieldsOf({ ...examples.number, answer: {} });
  assert.ok(missing["answer.correct"] && missing["answer.min"] && missing["answer.max"]);

  const { value } = validateQuestionInput({ ...examples.number, answer: { correct: 3, min: 0, max: 10 } });
  assert.deepEqual(value.answer, { correct: 3, tolerance: 0, partialRange: null, min: 0, max: 10, step: 1, unit: "" });

  const edge = validateQuestionInput(number({ correct: 0, tolerance: 2, partialRange: 2 }));
  assert.deepEqual(edge.fields, {});
  const nullPartial = validateQuestionInput(number({ partialRange: null }));
  assert.equal(nullPartial.value.answer.partialRange, null);
});

test("sort: size, duplicates, lengths, labels", () => {
  const sort = (answer) => ({ ...examples.sort, answer });
  assert.ok(fieldsOf(sort({ items: ["only"] }))["answer.items"]);
  assert.ok(fieldsOf(sort({ items: Array.from({ length: 9 }, (_, i) => `i${i}`) }))["answer.items"]);
  const dup = fieldsOf(sort({ items: ["Vanilla", "vanilla "] }));
  assert.ok(dup["answer.items[1]"]);
  assert.ok(fieldsOf(sort({ items: ["a", ""] }))["answer.items[1]"]);
  assert.ok(fieldsOf(sort({ items: ["a", "x".repeat(101)] }))["answer.items[1]"]);
  assert.ok(fieldsOf(sort({ items: ["a", "b"], startLabel: "x".repeat(25) }))["answer.startLabel"]);
  assert.ok(fieldsOf(sort({ items: ["a", "b"], correct: true }))["answer.correct"]);
  assert.ok(fieldsOf(sort({}))["answer.items"]);

  const { value } = validateQuestionInput(sort({ items: [" a ", "b"] }));
  assert.deepEqual(value.answer, { items: ["a", "b"], startLabel: "", endLabel: "" });
});

test("media questions: media is required and must match the type", () => {
  assert.match(fieldsOf({ ...examples.image, media: null }).media, /Required/);
  assert.match(fieldsOf({ ...examples.image, media: undefined }).media, /Required/);
  assert.ok(fieldsOf({ ...examples.image, media: { ...examples.image.media, kind: "audio" } })["media.kind"]);
  assert.ok(fieldsOf({ ...examples.audio, media: examples.image.media })["media.kind"]);
  assert.ok(fieldsOf({ ...examples.image, media: "trivia/a.png" }).media);
});

test("media questions: answer format rules", () => {
  assert.ok(fieldsOf({ ...examples.image, answer: { options: options(["A", true], ["B", false]) } })["answer.format"]);
  assert.ok(fieldsOf({ ...examples.image, answer: { format: "sort", items: ["a", "b"] } })["answer.format"]);
  assert.ok(fieldsOf({ ...examples.image, answer: { format: "true_false", correct: true, options: [] } })["answer.options"]);
  assert.ok(fieldsOf({ ...examples.image, answer: { format: "single_choice", options: options(["A", true], ["B", true]) } })["answer.options"]);

  const multi = validateQuestionInput({
    ...examples.image,
    answer: { format: "multi_select", options: options(["A", true], ["B", false]) },
  });
  assert.equal(multi.value.answer.scoring, "all_or_nothing");
  assert.equal(multi.value.answer.format, "multi_select");
});

test("media: upload key rules", () => {
  const media = (patch) => ({ ...examples.image, media: { ...examples.image.media, ...patch } });
  assert.ok(fieldsOf(media({ key: "news/abc.png" }))["media.key"]);
  assert.ok(fieldsOf(media({ key: "trivia/a/b.png" }))["media.key"]);
  assert.ok(fieldsOf(media({ key: "trivia/" }))["media.key"]);
  assert.ok(fieldsOf(media({ key: "trivia/.." }))["media.key"]);
  assert.ok(fieldsOf(media({ key: "trivia/a b.png" }))["media.key"]);
  assert.ok(fieldsOf(media({ key: 5 }))["media.key"]);
  assert.ok(fieldsOf(media({ key: undefined }))["media.key"]);
  assert.ok(fieldsOf(media({ sourceUrl: "https://example.com/a.mp4" }))["media.sourceUrl"]);
  assert.ok(fieldsOf(media({ source: "ftp" }))["media.source"]);
});

test("media: url source is video only and key is forbidden with it", () => {
  const image = { ...examples.image, media: { kind: "image", source: "url", sourceUrl: "https://example.com/a.png" } };
  assert.ok(fieldsOf(image)["media.source"]);
  const audio = { ...examples.audio, media: { kind: "audio", source: "url", sourceUrl: "https://example.com/a.mp4" } };
  assert.ok(fieldsOf(audio)["media.source"]);
  const withKey = { ...examples.video, media: { ...examples.video.media, key: "trivia/a.mp4" } };
  assert.ok(fieldsOf(withKey)["media.key"]);
  const noUrl = { ...examples.video, media: { kind: "video", source: "url" } };
  assert.ok(fieldsOf(noUrl)["media.sourceUrl"]);
});

test("media: bad video URLs are rejected", () => {
  const bad = [
    "javascript:alert(1)",
    "http://youtu.be/dQw4w9WgXcQ",
    "http://example.com/a.mp4",
    "data:video/mp4;base64,AAAA",
    "https://example.com/video.html",
    "https://example.com/a.mp4.exe",
    "https://evil.example/watch?v=dQw4w9WgXcQ",
    "https://www.youtube.com/watch?v=short",
    "https://www.youtube.com/playlist?list=abc",
    "https://user:pass@example.com/a.mp4",
    "//example.com/a.mp4",
    "not a url",
    "",
    "https://vimeo.com/notanumber",
    "https://notyoutube.com/embed/dQw4w9WgXcQ",
    "https://youtube.com.evil.example/embed/dQw4w9WgXcQ",
    42,
  ];
  for (const sourceUrl of bad) {
    const fields = fieldsOf({ ...examples.video, media: { kind: "video", source: "url", sourceUrl } });
    assert.ok(fields["media.sourceUrl"], `should reject ${JSON.stringify(sourceUrl)}`);
  }

  for (const sourceUrl of [
    "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
    "https://vimeo.com/76979871",
    "https://cdn.example.com/clips/a.webm?token=1",
    "https://example.com/A.MP4",
  ]) {
    const { fields } = validateQuestionInput({ ...examples.video, media: { kind: "video", source: "url", sourceUrl } });
    assert.deepEqual(fields, {}, sourceUrl);
  }
});

test("media: clip bounds", () => {
  const clip = (patch, example = examples.audio) => ({ ...example, media: { ...example.media, ...patch } });
  assert.ok(fieldsOf(clip({ startSeconds: -1 }))["media.startSeconds"]);
  assert.ok(fieldsOf(clip({ startSeconds: "1" }))["media.startSeconds"]);
  assert.ok(fieldsOf(clip({ startSeconds: 10, endSeconds: 10 }))["media.endSeconds"]);
  assert.ok(fieldsOf(clip({ startSeconds: 10, endSeconds: 5 }))["media.endSeconds"]);
  assert.ok(fieldsOf(clip({ startSeconds: 0, endSeconds: 0 }))["media.endSeconds"]);
  assert.ok(fieldsOf(clip({ startSeconds: 1 }, examples.image))["media.startSeconds"]);
  assert.ok(fieldsOf(clip({ endSeconds: 5 }, examples.image))["media.endSeconds"]);

  const open = validateQuestionInput(clip({ startSeconds: undefined, endSeconds: null }));
  assert.equal(open.value.media.startSeconds, 0);
  assert.equal(open.value.media.endSeconds, null);

  const image = validateQuestionInput(clip({ startSeconds: null, endSeconds: null }, examples.image));
  assert.deepEqual(image.fields, {});
  assert.equal("startSeconds" in image.value.media, false);
});

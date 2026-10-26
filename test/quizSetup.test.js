const test = require("node:test");
const assert = require("node:assert/strict");
const { QuizSetupError, normalizePool, normalizeSettings, normalizeTitle } = require("../src/services/quiz/quizSetup");

const available = new Map([["single_choice", 6], ["true_false", 3]]);

function fields(work) {
  try {
    work();
  } catch (error) {
    assert.ok(error instanceof QuizSetupError);
    return error.fields;
  }
  assert.fail("expected QuizSetupError");
}

test("pool: a count per type, skipping zeros", () => {
  assert.deepEqual(
    normalizePool({
      types: [
        { type: "single_choice", count: 2 },
        { type: "true_false", count: 3 },
      ],
    }, available),
    { types: [{ type: "single_choice", count: 2 }, { type: "true_false", count: 3 }], count: 5 },
  );
});

test("pool: empty, unknown and over-count are field errors", () => {
  assert.equal(fields(() => normalizePool({ types: [] }, available)).types, "Choose how many questions you want from at least one type.");
  assert.match(fields(() => normalizePool({ types: [{ type: "sort", count: 1 }] }, available))["types[0].type"], /no ready/);
  assert.match(fields(() => normalizePool({ types: [{ type: "map", count: 1 }] }, available))["types[0].type"], /not a question type/);
  assert.match(fields(() => normalizePool({ types: [{ type: "single_choice", count: 7 }] }, available))["types[0].count"], /Only 6/);
  assert.match(fields(() => normalizePool({ types: [{ type: "single_choice", count: 0 }] }, available)).types, /at least one type/);
});

test("settings clamp to safe values and keep defaults", () => {
  assert.deepEqual(normalizeSettings(), {
    introMs: 3000,
    revealMs: 8000,
    leaderboardMs: 8000,
    autoAdvance: false,
    endWhenAllAnswered: true,
  });
  assert.deepEqual(normalizeSettings({
    introSeconds: 1,
    revealSeconds: 99,
    leaderboardSeconds: 4,
    autoAdvance: true,
    endWhenAllAnswered: false,
  }), {
    introMs: 2000,
    revealMs: 30000,
    leaderboardMs: 4000,
    autoAdvance: true,
    endWhenAllAnswered: false,
  });
});

test("the title falls back to the event name and is capped", () => {
  assert.equal(normalizeTitle("  Night  ", "Raid"), "Night");
  assert.equal(normalizeTitle("", "The quiz"), "The quiz");
  assert.equal(normalizeTitle("", ""), "Quiz night");
  assert.equal(normalizeTitle("x".repeat(100)).length, 80);
});

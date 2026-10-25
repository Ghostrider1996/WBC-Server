const test = require("node:test");
const assert = require("node:assert/strict");
const { QuizSetupError, normalizeRounds, normalizeSettings, normalizeTitle } = require("../src/services/quiz/quizSetup");

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

test("rounds: each type once, counts within what is ready", () => {
  assert.deepEqual(
    normalizeRounds([{ type: "single_choice", count: 2 }, { type: "true_false", count: 3 }], available),
    [{ type: "single_choice", count: 2 }, { type: "true_false", count: 3 }],
  );
});

test("rounds: empty, duplicate, unknown and over-count are field errors", () => {
  assert.equal(fields(() => normalizeRounds([], available)).rounds, "Add at least one round.");
  assert.match(fields(() => normalizeRounds(
    [{ type: "single_choice", count: 1 }, { type: "single_choice", count: 1 }],
    available,
  ))["rounds[1].type"], /once/);
  assert.match(fields(() => normalizeRounds([{ type: "sort", count: 1 }], available))["rounds[0].type"], /no ready/);
  assert.match(fields(() => normalizeRounds([{ type: "map", count: 1 }], available))["rounds[0].type"], /not a question type/);
  assert.match(fields(() => normalizeRounds([{ type: "single_choice", count: 7 }], available))["rounds[0].count"], /Only 6/);
  assert.match(fields(() => normalizeRounds([{ type: "single_choice", count: 0 }], available))["rounds[0].count"], /1 to 50/);
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

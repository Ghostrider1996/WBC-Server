const test = require("node:test");
const assert = require("node:assert/strict");
const { QuizSetupError, normalizeRounds, normalizeSettings, normalizeTitle } = require("../src/services/quiz/quizSetup");

const available = new Map([["Guild", 6], ["Forever", 3]]);

function fields(work) {
  try {
    work();
  } catch (error) {
    assert.ok(error instanceof QuizSetupError);
    return error.fields;
  }
  assert.fail("expected QuizSetupError");
}

test("rounds: each category once, counts within what is ready", () => {
  assert.deepEqual(
    normalizeRounds([{ category: " Guild ", count: 2 }, { category: "Forever", count: 3 }], available),
    [{ category: "Guild", count: 2 }, { category: "Forever", count: 3 }],
  );
});

test("rounds: empty, duplicate, unknown and over-count are field errors", () => {
  assert.equal(fields(() => normalizeRounds([], available)).rounds, "Add at least one round.");
  assert.match(fields(() => normalizeRounds(
    [{ category: "Guild", count: 1 }, { category: "guild", count: 1 }],
    available,
  ))["rounds[1].category"], /once/);
  assert.match(fields(() => normalizeRounds([{ category: "Classic", count: 1 }], available))["rounds[0].category"], /no ready/);
  assert.match(fields(() => normalizeRounds([{ category: "Guild", count: 7 }], available))["rounds[0].count"], /Only 6/);
  assert.match(fields(() => normalizeRounds([{ category: "Guild", count: 0 }], available))["rounds[0].count"], /1 to 50/);
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

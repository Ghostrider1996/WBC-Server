const test = require("node:test");
const assert = require("node:assert/strict");
const { createSignupChecker, isSignedUp } = require("../src/services/quiz/quizAccess");

const event = {
  signUps: [
    { userId: "1", status: "present" },
    { userId: "2", status: "late" },
    { userId: "3", status: "tentative" },
    { userId: "4", status: "absence" },
    { userId: "5", className: "Absent" },
    { user: { id: "6" }, status: "present" },
  ],
};

test("late and tentative count as signed up; absent does not", () => {
  assert.equal(isSignedUp(event, "1"), true);
  assert.equal(isSignedUp(event, "2"), true);
  assert.equal(isSignedUp(event, "3"), true);
  assert.equal(isSignedUp(event, "4"), false);
  assert.equal(isSignedUp(event, "5"), false);
  assert.equal(isSignedUp(event, "6"), true);
  assert.equal(isSignedUp(event, "99"), false);
  assert.equal(isSignedUp({}, "1"), false);
});

test("the checker caches a successful lookup and refreshes after a miss", async () => {
  let now = 1_000_000;
  let loads = 0;
  const checker = createSignupChecker({
    now: () => now,
    ttlMs: 30_000,
    getEvent: async () => {
      loads += 1;
      return event;
    },
  });

  assert.equal(await checker.isSignedUp("ev", "1"), true);
  assert.equal(await checker.isSignedUp("ev", "1"), true);
  assert.equal(loads, 1);

  assert.equal(await checker.isSignedUp("ev", "99"), false);
  assert.equal(loads, 1);

  now += 6_000;
  assert.equal(await checker.isSignedUp("ev", "99"), false);
  assert.equal(loads, 2);
});

test("a failed Raid Helper lookup is not cached", async () => {
  let loads = 0;
  const checker = createSignupChecker({
    getEvent: async () => {
      loads += 1;
      throw new Error("down");
    },
  });

  await assert.rejects(() => checker.isSignedUp("ev", "1"), /down/);
  await assert.rejects(() => checker.isSignedUp("ev", "1"), /down/);
  assert.equal(loads, 2);
});

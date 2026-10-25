const test = require("node:test");
const assert = require("node:assert/strict");
const {
  gradeResponse,
  normalizeResponse,
  pointsFor,
  toPlayerQuestion,
  toReveal,
} = require("../src/services/quiz/quizScoring");

const noShuffle = () => 0.999999;

const single = {
  id: "q1",
  type: "single_choice",
  prompt: "Pick one",
  category: "Guild",
  difficulty: "easy",
  timeLimitSeconds: 20,
  points: 1000,
  explanation: "Because.",
  media: null,
  answer: { options: [{ text: "A", correct: false }, { text: "B", correct: true }, { text: "C", correct: false }] },
};

const multi = (scoring) => ({
  ...single,
  type: "multi_select",
  answer: {
    scoring,
    options: [
      { text: "A", correct: true },
      { text: "B", correct: true },
      { text: "C", correct: false },
      { text: "D", correct: false },
    ],
  },
});

const number = {
  ...single,
  type: "number",
  answer: { correct: 50, tolerance: 2, partialRange: 12, min: 0, max: 100, step: 1, unit: "g" },
};

const sort = {
  ...single,
  type: "sort",
  answer: { items: ["first", "second", "third", "fourth"], startLabel: "Oldest", endLabel: "Newest" },
};

test("the player view never contains the solution", () => {
  for (const question of [single, multi("partial"), number, sort, { ...single, type: "true_false", answer: { correct: true } }]) {
    const view = JSON.stringify(toPlayerQuestion(question));
    assert.ok(!view.includes('"correct"'), `${question.type} leaked a correct flag`);
    assert.ok(!view.includes("Because."), `${question.type} leaked the explanation`);
  }

  const numberView = toPlayerQuestion(number);
  assert.deepEqual(numberView.number, { min: 0, max: 100, step: 1, unit: "g" });
});

test("choice options keep their stored index as an id and are shuffled", () => {
  const view = toPlayerQuestion(single, { random: () => 0 });
  assert.deepEqual(view.options.map((option) => option.id).sort(), [0, 1, 2]);
  assert.notDeepEqual(view.options.map((option) => option.id), [0, 1, 2]);
  assert.equal(view.options.find((option) => option.id === 1).text, "B");
});

test("sort items are not sent in the correct order", () => {
  const view = toPlayerQuestion(sort, { random: () => 0 });
  assert.notDeepEqual(view.items.map((item) => item.id), [0, 1, 2, 3]);
  assert.equal(view.startLabel, "Oldest");
});

test("media questions are shown and graded through their answer format", () => {
  const image = { ...single, type: "image", answer: { format: "single_choice", options: single.answer.options } };
  assert.equal(toPlayerQuestion(image, { random: noShuffle }).format, "single_choice");
  assert.equal(gradeResponse(image, 1).verdict, "correct");
  assert.equal(gradeResponse(image, 0).verdict, "wrong");
});

test("the reveal carries the solution in the shape the client renders", () => {
  assert.deepEqual(toReveal(single).correctIds, [1]);
  assert.equal(toReveal(single).explanation, "Because.");
  assert.deepEqual(toReveal(sort).correctOrder, [0, 1, 2, 3]);
  assert.equal(toReveal(number).correct, 50);
});

test("responses are validated per format", () => {
  assert.equal(normalizeResponse(single, 1), 1);
  assert.equal(normalizeResponse(single, 5), null);
  assert.equal(normalizeResponse(single, "1"), null);

  assert.deepEqual(normalizeResponse(multi("partial"), [1, 0]), [0, 1]);
  assert.equal(normalizeResponse(multi("partial"), []), null);
  assert.equal(normalizeResponse(multi("partial"), [0, 0]), null);
  assert.equal(normalizeResponse(multi("partial"), [9]), null);

  assert.equal(normalizeResponse(number, 42), 42);
  assert.equal(normalizeResponse(number, 101), null);
  assert.equal(normalizeResponse(number, Number.NaN), null);
  assert.equal(normalizeResponse(number, "42"), null);

  assert.deepEqual(normalizeResponse(sort, [3, 2, 1, 0]), [3, 2, 1, 0]);
  assert.equal(normalizeResponse(sort, [0, 1, 2]), null);
  assert.equal(normalizeResponse(sort, [0, 1, 2, 2]), null);

  const trueFalse = { ...single, type: "true_false", answer: { correct: false } };
  assert.equal(normalizeResponse(trueFalse, true), true);
  assert.equal(normalizeResponse(trueFalse, "true"), null);
});

test("single choice and true/false are right or wrong", () => {
  assert.deepEqual(gradeResponse(single, 1), { fraction: 1, verdict: "correct" });
  assert.deepEqual(gradeResponse(single, 0), { fraction: 0, verdict: "wrong" });

  const trueFalse = { ...single, type: "true_false", answer: { correct: true } };
  assert.equal(gradeResponse(trueFalse, true).verdict, "correct");
  assert.equal(gradeResponse(trueFalse, false).verdict, "wrong");
});

test("multi select: all or nothing", () => {
  const question = multi("all_or_nothing");
  assert.equal(gradeResponse(question, [0, 1]).verdict, "correct");
  assert.equal(gradeResponse(question, [0]).verdict, "wrong");
  assert.equal(gradeResponse(question, [0, 1, 2]).verdict, "wrong");
});

test("multi select: partial credit rewards hits and penalises misses", () => {
  const question = multi("partial");
  assert.equal(gradeResponse(question, [0, 1]).fraction, 1);
  assert.deepEqual(gradeResponse(question, [0]), { fraction: 0.5, verdict: "partial" });
  assert.equal(gradeResponse(question, [0, 1, 2]).fraction, 0.5);
  assert.equal(gradeResponse(question, [2, 3]).fraction, 0);
  assert.equal(gradeResponse(question, [2]).verdict, "wrong");
});

test("number: tolerance is full credit, the partial range falls off linearly", () => {
  assert.equal(gradeResponse(number, 50).verdict, "correct");
  assert.equal(gradeResponse(number, 52).verdict, "correct");
  assert.equal(gradeResponse(number, 48).verdict, "correct");
  assert.equal(gradeResponse(number, 53).fraction, 0.5 * (1 - 1 / 10));
  assert.equal(gradeResponse(number, 53).verdict, "partial");
  assert.equal(gradeResponse(number, 62).fraction, 0);
  assert.equal(gradeResponse(number, 63).verdict, "wrong");

  const strict = { ...number, answer: { ...number.answer, partialRange: null } };
  assert.equal(gradeResponse(strict, 53).verdict, "wrong");
});

test("sort: credit for each item in the right place", () => {
  assert.equal(gradeResponse(sort, [0, 1, 2, 3]).verdict, "correct");
  assert.deepEqual(gradeResponse(sort, [0, 1, 3, 2]), { fraction: 0.5, verdict: "partial" });
  assert.equal(gradeResponse(sort, [1, 0, 3, 2]).verdict, "wrong");
});

test("points: speed scales a correct answer between half and full", () => {
  const question = { points: 1000 };
  assert.equal(pointsFor(question, 1, 20000, 20000), 1000);
  assert.equal(pointsFor(question, 1, 10000, 20000), 750);
  assert.equal(pointsFor(question, 1, 0, 20000), 500);
  assert.equal(pointsFor(question, 0.5, 20000, 20000), 500);
  assert.equal(pointsFor(question, 0, 20000, 20000), 0);
  assert.equal(pointsFor(question, 1, -50, 20000), 500);
  assert.equal(pointsFor(question, 1, 99999, 20000), 1000);
});

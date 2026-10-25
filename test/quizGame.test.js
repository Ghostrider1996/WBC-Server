const test = require("node:test");
const assert = require("node:assert/strict");
const { QuizGame, QuizGameError } = require("../src/services/quiz/quizGame");

function createClock(start = 1_000_000) {
  let current = start;
  let nextId = 1;
  let timers = [];

  return {
    now: () => current,
    setTimer(callback, ms) {
      const timer = { id: nextId++, at: current + ms, callback };
      timers.push(timer);
      return timer;
    },
    clearTimer(timer) {
      timers = timers.filter((entry) => entry !== timer);
    },
    pending: () => timers.length,
    advance(ms) {
      const target = current + ms;
      for (;;) {
        const due = timers.filter((timer) => timer.at <= target).sort((a, b) => a.at - b.at || a.id - b.id)[0];
        if (!due) break;
        timers = timers.filter((timer) => timer !== due);
        current = Math.max(current, due.at);
        due.callback();
      }
      current = target;
    },
  };
}

function choiceQuestion(id, roundIndex, { points = 1000, seconds = 20 } = {}) {
  return {
    id,
    type: "single_choice",
    prompt: `Question ${id}`,
    explanation: `Why ${id}`,
    category: `Round ${roundIndex}`,
    difficulty: "easy",
    timeLimitSeconds: seconds,
    points,
    media: null,
    answer: { options: [{ text: "Right", correct: true }, { text: "Wrong", correct: false }] },
    roundIndex,
    roundTitle: `Round ${roundIndex}`,
  };
}

function setup({ settings, questions } = {}) {
  const clock = createClock();
  const game = new QuizGame({
    id: "game-1",
    title: "Quiz night",
    settings: { introMs: 3000, graceMs: 400, ...settings },
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    random: () => 0.5,
  });

  for (const [id, name] of [["a", "Alice"], ["b", "Bob"], ["c", "Cara"]]) {
    game.addPlayer({ discordId: id, name });
    game.setConnected(id, true);
  }

  const list = questions || [choiceQuestion("q1", 0), choiceQuestion("q2", 0), choiceQuestion("q3", 1)];
  return { clock, game, list };
}

/** The option id of the right/wrong answer, read off the stored question. */
const RIGHT = 0;
const WRONG = 1;

function thrownCode(work) {
  try {
    work();
  } catch (error) {
    assert.ok(error instanceof QuizGameError, `expected QuizGameError, got ${error}`);
    return error.code;
  }
  return null;
}

test("a game cannot start without questions or without players", () => {
  const empty = new QuizGame({ id: "x" });
  empty.addPlayer({ discordId: "a", name: "A" });
  assert.equal(thrownCode(() => empty.start([])), "no_questions");

  const lonely = new QuizGame({ id: "y" });
  assert.equal(thrownCode(() => lonely.start([choiceQuestion("q", 0)])), "no_players");
});

test("intro runs on a timer, then the question opens with a server-owned deadline", () => {
  const { clock, game, list } = setup();
  game.start(list);
  assert.equal(game.phase, "intro");
  assert.equal(game.publicState().round.title, "Round 0");
  assert.equal(game.publicState().question, undefined);

  clock.advance(2999);
  assert.equal(game.phase, "intro");
  clock.advance(1);
  assert.equal(game.phase, "question");

  const state = game.publicState();
  assert.equal(state.timer.totalMs, 20000);
  assert.equal(state.timer.endsAt - state.timer.startedAt, 20000);
  assert.equal(state.question.id, "q1");
});

test("the solution is not in the public or player state until the reveal", () => {
  const { clock, game, list } = setup();
  game.start(list);
  clock.advance(3000);

  const during = JSON.stringify([game.publicState(), game.playerState("a"), game.hostState()]);
  assert.ok(!during.includes('"correct"'));
  assert.ok(!during.includes("Why q1"));

  clock.advance(20400);
  assert.equal(game.phase, "reveal");
  assert.deepEqual(game.publicState().reveal.correctIds, [RIGHT]);
  assert.equal(game.publicState().reveal.explanation, "Why q1");
});

test("a correct answer is scored by speed and shown on the leaderboard at the reveal", () => {
  const { clock, game, list } = setup();
  game.start(list);
  clock.advance(3000);

  clock.advance(5000);
  game.submitAnswer("a", RIGHT);
  clock.advance(5000);
  game.submitAnswer("b", RIGHT);
  clock.advance(2000);
  game.submitAnswer("c", WRONG);

  assert.equal(game.phase, "reveal");
  const board = game.publicState().standings;
  assert.deepEqual(board.map((entry) => entry.name), ["Alice", "Bob", "Cara"]);
  // 15s of 20s left => 0.5 + 0.5 * 0.75 = 0.875; 10s left => 0.75.
  assert.equal(board[0].score, 875);
  assert.equal(board[1].score, 750);
  assert.equal(board[2].score, 0);
  assert.equal(game.playerState("a").result.verdict, "correct");
  assert.equal(game.playerState("c").result.verdict, "wrong");
});

test("one answer per player per question; changes are refused", () => {
  const { clock, game, list } = setup();
  game.start(list);
  clock.advance(3000);

  game.submitAnswer("a", WRONG);
  assert.equal(thrownCode(() => game.submitAnswer("a", RIGHT)), "already_answered");
  assert.equal(game.playerState("a").response, WRONG);
});

test("answers outside the question window, from strangers or malformed are refused", () => {
  const { clock, game, list } = setup();
  game.start(list);
  assert.equal(thrownCode(() => game.submitAnswer("a", RIGHT)), "closed");

  clock.advance(3000);
  assert.equal(thrownCode(() => game.submitAnswer("zzz", RIGHT)), "not_playing");
  assert.equal(thrownCode(() => game.submitAnswer("a", 7)), "invalid");
  assert.equal(thrownCode(() => game.submitAnswer("a", "0")), "invalid");
  assert.equal(game.progressSnapshot().answered, 0);
});

test("the grace window allows a just-late answer but never after it", () => {
  const { clock, game, list } = setup({ settings: { endWhenAllAnswered: false } });
  game.start(list);
  clock.advance(3000);

  clock.advance(20000 + 300);
  assert.equal(game.phase, "question");
  game.submitAnswer("a", RIGHT);
  assert.equal(game.playerState("a").answered, true);

  clock.advance(100);
  assert.equal(game.phase, "reveal");
  // Answered after the buzzer: still correct, but the speed share bottoms out at half.
  assert.equal(game.publicState().standings[0].score, 500);
  assert.equal(thrownCode(() => game.submitAnswer("b", RIGHT)), "closed");
});

test("the question ends early once every connected player has answered", () => {
  const { clock, game, list } = setup();
  game.start(list);
  clock.advance(3000);

  game.submitAnswer("a", RIGHT);
  game.submitAnswer("b", RIGHT);
  assert.equal(game.phase, "question");
  game.submitAnswer("c", WRONG);
  assert.equal(game.phase, "reveal");
  assert.equal(clock.pending(), 0);
});

test("a disconnected player does not hold the question open", () => {
  const { clock, game, list } = setup();
  game.start(list);
  clock.advance(3000);

  game.submitAnswer("a", RIGHT);
  game.submitAnswer("b", RIGHT);
  game.setConnected("c", false);
  assert.equal(game.phase, "reveal");
});

test("players who do not answer score nothing and are counted in the reveal", () => {
  const { clock, game, list } = setup();
  game.start(list);
  clock.advance(3000);
  game.submitAnswer("a", RIGHT);
  clock.advance(20400);

  const { verdictCounts, choices } = game.publicState().reveal;
  assert.deepEqual(verdictCounts, { correct: 1, partial: 0, wrong: 0, noAnswer: 2 });
  assert.deepEqual(choices, { 0: 1 });
  assert.equal(game.playerState("b").result.answered, false);
});

test("pause freezes the timer and resume restores the remaining time", () => {
  const { clock, game, list } = setup();
  game.start(list);
  clock.advance(3000);
  clock.advance(8000);

  game.pause();
  assert.equal(game.publicState().timer.paused, true);
  assert.equal(game.publicState().timer.remainingMs, 12000);
  assert.equal(thrownCode(() => game.submitAnswer("a", RIGHT)), "closed");

  clock.advance(60000);
  assert.equal(game.phase, "question");

  game.resume();
  assert.equal(game.publicState().timer.remainingMs, 12000);
  clock.advance(12399);
  assert.equal(game.phase, "question");
  clock.advance(1);
  assert.equal(game.phase, "reveal");
});

test("extend adds time to a running question", () => {
  const { clock, game, list } = setup();
  game.start(list);
  clock.advance(3000);

  game.extend(10);
  assert.equal(game.publicState().timer.totalMs, 30000);
  clock.advance(29999);
  assert.equal(game.phase, "question");
  clock.advance(401);
  assert.equal(game.phase, "reveal");
});

test("rounds: leaderboard shows between rounds, not between questions of one round", () => {
  const { clock, game, list } = setup();
  game.start(list);

  clock.advance(3000);
  game.next();
  assert.equal(game.phase, "reveal");
  game.next();
  assert.equal(game.phase, "intro");
  assert.equal(game.publicState().question, undefined);
  assert.equal(game.publicState().round.questionNumber, 2);

  game.next();
  assert.equal(game.phase, "question");
  game.next();
  assert.equal(game.phase, "reveal");
  game.next();
  assert.equal(game.phase, "leaderboard");
  game.next();
  assert.equal(game.phase, "intro");
  assert.equal(game.publicState().round.title, "Round 1");

  game.next();
  game.next();
  assert.equal(game.phase, "reveal");
  game.next();
  assert.equal(game.phase, "finished");
});

test("auto advance moves through reveal and leaderboard on timers", () => {
  const { clock, game, list } = setup({
    settings: { autoAdvance: true, revealMs: 5000, leaderboardMs: 4000 },
    questions: [choiceQuestion("q1", 0), choiceQuestion("q2", 1)],
  });
  game.start(list);
  clock.advance(3000);

  game.submitAnswer("a", RIGHT);
  game.submitAnswer("b", RIGHT);
  game.submitAnswer("c", RIGHT);
  assert.equal(game.phase, "reveal");
  assert.ok(game.publicState().nextAt > clock.now());

  clock.advance(5000);
  assert.equal(game.phase, "leaderboard");
  clock.advance(4000);
  assert.equal(game.phase, "intro");
});

test("ranking breaks score ties by total response time and shares equal ranks", () => {
  const { clock, game, list } = setup({ questions: [choiceQuestion("q1", 0, { points: 0 }), choiceQuestion("q2", 0)] });
  game.start(list);
  clock.advance(3000);
  game.next();
  game.next();
  game.next();
  assert.equal(game.phase, "question");

  // Same score for a and b (both answer instantly or both wrong): c wins on points.
  game.submitAnswer("c", RIGHT);
  clock.advance(1000);
  game.submitAnswer("a", WRONG);
  game.submitAnswer("b", WRONG);
  const board = game.publicState().standings;
  assert.equal(board[0].name, "Cara");
  assert.equal(board[1].rank, 2);
  assert.equal(board[2].rank, 2);
});

test("rank changes are reported against the previous standings", () => {
  const { clock, game, list } = setup();
  game.start(list);
  clock.advance(3000);

  clock.advance(5000);
  game.submitAnswer("a", RIGHT);
  game.submitAnswer("b", WRONG);
  game.submitAnswer("c", WRONG);
  const first = game.publicState().standings;
  assert.equal(first[0].name, "Alice");
  assert.equal(first[0].score, 875);
  assert.deepEqual(first.map((entry) => entry.rank), [1, 2, 2]);

  game.next();
  game.next();

  game.submitAnswer("c", RIGHT);
  game.submitAnswer("a", WRONG);
  game.submitAnswer("b", WRONG);
  const second = game.publicState().standings;
  assert.deepEqual(second.map((entry) => entry.name), ["Cara", "Alice", "Bob"]);
  assert.equal(second[0].rankChange, 1);
  assert.equal(second[1].rankChange, -1);
  assert.equal(second[2].rankChange, -1);
  assert.equal(second[0].gain, 1000);
});

test("late joiners are refused but returning players are let back in", () => {
  const { clock, game, list } = setup();
  game.start(list);
  clock.advance(3000);

  assert.equal(thrownCode(() => game.addPlayer({ discordId: "new", name: "New" })), "started");
  game.setConnected("a", false);
  game.addPlayer({ discordId: "a", name: "Alice" });
  game.setConnected("a", true);
  assert.equal(game.playerState("a").joined, true);
});

test("kicking removes a player, drops their answer and blocks rejoining", () => {
  const { clock, game, list } = setup();
  game.start(list);
  clock.advance(3000);
  game.submitAnswer("a", RIGHT);

  assert.equal(game.kick("a"), true);
  assert.equal(game.progressSnapshot().answered, 0);
  assert.equal(game.publicState().standings.some((entry) => entry.discordId === "a"), false);
  assert.equal(thrownCode(() => game.addPlayer({ discordId: "a", name: "Alice" })), "removed");
  assert.equal(game.kick("a"), false);
});

test("ending early grades the open question and finishes with standings", () => {
  const { clock, game, list } = setup();
  const finished = [];
  game.on("finished", (summary) => finished.push(summary));
  game.start(list);
  clock.advance(3000);
  game.submitAnswer("a", RIGHT);

  game.end();
  assert.equal(game.phase, "finished");
  assert.equal(finished.length, 1);
  assert.equal(finished[0].cancelled, false);
  assert.ok(finished[0].standings[0].score > 0);
  assert.equal(clock.pending(), 0);

  game.end();
  assert.equal(finished.length, 1);
});

test("cancelling finishes the game flagged as cancelled", () => {
  const { game } = setup();
  const finished = [];
  game.on("finished", (summary) => finished.push(summary));
  game.end({ cancelled: true });
  assert.equal(finished[0].cancelled, true);
  assert.equal(game.publicState().cancelled, true);
});

test("each graded question is announced once with every player's result", () => {
  const { clock, game, list } = setup();
  const locked = [];
  game.on("locked", (summary) => locked.push(summary));
  game.start(list);
  clock.advance(3000);
  game.submitAnswer("a", RIGHT);
  clock.advance(20400);

  assert.equal(locked.length, 1);
  assert.equal(locked[0].index, 0);
  assert.deepEqual(locked[0].results.map((entry) => entry.discordId), ["a"]);
  assert.equal(locked[0].standings.length, 3);
});

test("host controls are refused in the wrong phase", () => {
  const { game } = setup();
  assert.equal(thrownCode(() => game.next()), "bad_phase");
  assert.equal(thrownCode(() => game.pause()), "bad_phase");
  assert.equal(thrownCode(() => game.resume()), "bad_phase");
  assert.equal(thrownCode(() => game.extend(5)), "bad_phase");
});

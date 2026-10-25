const test = require("node:test");
const assert = require("node:assert/strict");
const { QuizManager } = require("../src/services/quiz/quizManager");
const { QuizGame } = require("../src/services/quiz/quizGame");

const SESSION = {
  id: "s1",
  title: "Night",
  raidHelperEventId: "event-1",
  hostDiscordId: "host",
  status: "lobby",
  rounds: [{ type: "true_false", count: 1 }],
  settings: { introMs: 10 },
};

function question() {
  return {
    id: "q1",
    type: "true_false",
    prompt: "Yes?",
    explanation: "",
    category: "Guild",
    difficulty: "easy",
    timeLimitSeconds: 10,
    points: 100,
    media: null,
    answer: { correct: true },
    roundIndex: 0,
    roundTitle: "Guild",
  };
}

function createStore(session = SESSION) {
  const calls = { finished: [], started: [] };
  return {
    calls,
    getSession: async (id) => (id === session.id ? session : null),
    pickQuestions: async () => [question()],
    markStarted: async (id) => { calls.started.push(id); },
    markFinished: async (id, summary) => { calls.finished.push([id, summary]); },
    saveLockedQuestion: async () => {},
  };
}

test("a lobby session is loaded into memory the first time someone asks for it", async () => {
  const store = createStore();
  const manager = new QuizManager({ store, logger: { error() {} } });
  const game = await manager.getGame("s1");
  assert.ok(game instanceof QuizGame);
  assert.equal(game.phase, "lobby");
  assert.equal(await manager.getGame("s1"), game);
  assert.equal(await manager.getGame("missing"), null);
});

test("a live session found after a restart is closed instead of being resumed", async () => {
  const store = createStore({ ...SESSION, status: "live" });
  const manager = new QuizManager({ store, logger: { error() {} } });
  assert.equal(await manager.getGame("s1"), null);
  assert.equal(store.calls.finished[0][1].cancelled, true);
});

test("start draws questions, opens the game and records it", async () => {
  const store = createStore();
  const manager = new QuizManager({ store, logger: { error() {} } });
  const game = await manager.getGame("s1");
  game.addPlayer({ discordId: "a", name: "A" });

  await manager.start("s1");
  assert.equal(game.phase, "intro");
  assert.equal(game.questions[0].id, "q1");
  assert.deepEqual(store.calls.started, ["s1"]);
});

test("cancel ends a live game or an unused lobby row", async () => {
  const store = createStore();
  const manager = new QuizManager({ store, logger: { error() {} } });
  const game = await manager.getGame("s1");
  game.addPlayer({ discordId: "a", name: "A" });
  await manager.cancel("s1");
  assert.equal(game.phase, "finished");
  assert.equal(game.cancelled, true);

  const unused = createStore({ ...SESSION, id: "s2" });
  const idle = new QuizManager({ store: unused, logger: { error() {} } });
  await idle.cancel("s2");
  assert.equal(unused.calls.finished[0][1].cancelled, true);
});

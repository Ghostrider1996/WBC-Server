process.env.SESSION_SECRET = "test-session-secret";

const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const { io: connect } = require("socket.io-client");
const { attachQuizSockets } = require("../src/services/quiz/quizSocket");
const { QuizManager } = require("../src/services/quiz/quizManager");
const { signSessionToken } = require("../src/services/sessionToken");

const SESSION_ID = "11111111-1111-4111-8111-111111111111";
const HOST = "100000000000000001";
const ALICE = "200000000000000001";
const BOB = "200000000000000002";
const OUTSIDER = "300000000000000001";
const NAMES = { [HOST]: "Host", [ALICE]: "Alice", [BOB]: "Bob", [OUTSIDER]: "Outsider" };

function question(id) {
  return {
    id,
    type: "single_choice",
    prompt: `Question ${id}`,
    explanation: "Because it is.",
    category: "Guild",
    difficulty: "easy",
    timeLimitSeconds: 20,
    points: 1000,
    media: null,
    answer: { options: [{ text: "Right", correct: true }, { text: "Wrong", correct: false }] },
    roundIndex: 0,
    roundTitle: "Guild",
  };
}

function createStore() {
  const calls = { locked: [], finished: [], started: [] };
  return {
    calls,
    getSession: async (id) => (id === SESSION_ID
      ? {
        id,
        title: "Test quiz",
        raidHelperEventId: "event-1",
        hostDiscordId: HOST,
        status: "lobby",
        rounds: [{ category: "Guild", count: 1 }],
        settings: { introMs: 40, graceMs: 40, revealMs: 5000, leaderboardMs: 5000, autoAdvance: false, endWhenAllAnswered: true },
      }
      : null),
    pickQuestions: async () => [question("q1")],
    markStarted: async (id, questions) => { calls.started.push([id, questions.length]); },
    saveLockedQuestion: async (id, summary) => { calls.locked.push([id, summary]); },
    markFinished: async (id, summary) => { calls.finished.push([id, summary]); },
  };
}

class Client {
  constructor(url, discordId, { token } = {}) {
    this.discordId = discordId;
    this.last = null;
    this.events = [];
    this.waiters = [];
    this.socket = connect(url, {
      auth: { token: token === undefined ? signSessionToken(discordId) : token },
      transports: ["websocket"],
      reconnection: false,
    });
    this.socket.on("quiz:state", (payload) => {
      this.last = payload;
      this.waiters = this.waiters.filter((waiter) => !waiter(payload));
    });
    for (const name of ["quiz:replaced", "quiz:removed"]) {
      this.socket.on(name, () => this.events.push(name));
    }
  }

  opened() {
    return new Promise((resolve, reject) => {
      this.socket.once("connect", resolve);
      this.socket.once("connect_error", reject);
    });
  }

  emit(event, payload) {
    return this.socket.timeout(3000).emitWithAck(event, payload);
  }

  waitFor(predicate, label) {
    if (this.last && predicate(this.last)) return Promise.resolve(this.last);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`Timed out waiting for ${label}`)), 3000);
      this.waiters.push((payload) => {
        if (!predicate(payload)) return false;
        clearTimeout(timer);
        resolve(payload);
        return true;
      });
    });
  }

  close() {
    this.socket.close();
  }
}

async function startServer(overrides = {}) {
  const store = createStore();
  const manager = new QuizManager({ store, logger: { error() {} } });
  const server = http.createServer();
  const quiz = attachQuizSockets(server, {
    manager,
    signups: { isSignedUp: async (_event, id) => [ALICE, BOB].includes(id) },
    isTriviaAdmin: async (id) => id === HOST,
    loadProfile: async (id) => ({ name: NAMES[id], avatar: null }),
    isAllowedOrigin: () => true,
    ...overrides,
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${server.address().port}`;

  const clients = [];
  return {
    store,
    manager,
    url,
    client(discordId, options) {
      const client = new Client(url, discordId, options);
      clients.push(client);
      return client;
    },
    async stop() {
      clients.forEach((client) => client.close());
      await quiz.close();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

test("connections without a valid Discord session are refused", async () => {
  const harness = await startServer();
  try {
    await assert.rejects(harness.client(ALICE, { token: "" }).opened(), /Sign in with Discord/);
    await assert.rejects(harness.client(ALICE, { token: "garbage.token" }).opened(), /Sign in with Discord/);
  } finally {
    await harness.stop();
  }
});

test("only people signed up to the event can join as players", async () => {
  const harness = await startServer();
  try {
    const outsider = harness.client(OUTSIDER);
    await outsider.opened();
    const denied = await outsider.emit("quiz:join", { sessionId: SESSION_ID });
    assert.equal(denied.ok, false);
    assert.equal(denied.code, "not_signed_up");

    const alice = harness.client(ALICE);
    await alice.opened();
    const joined = await alice.emit("quiz:join", { sessionId: SESSION_ID });
    assert.equal(joined.ok, true);
    assert.equal(joined.role, "player");
    assert.equal(joined.state.phase, "lobby");
    assert.equal(joined.you.joined, true);

    const missing = await alice.emit("quiz:join", { sessionId: "22222222-2222-4222-8222-222222222222" });
    assert.equal(missing.code, "not_found");
    const malformed = await alice.emit("quiz:join", { sessionId: "nope" });
    assert.equal(malformed.code, "not_found");
  } finally {
    await harness.stop();
  }
});

test("a failed sign-up lookup refuses the join instead of guessing", async () => {
  const harness = await startServer({
    signups: { isSignedUp: async () => { throw new Error("Raid Helper is down"); } },
  });
  try {
    const alice = harness.client(ALICE);
    await alice.opened();
    const result = await alice.emit("quiz:join", { sessionId: SESSION_ID });
    assert.equal(result.ok, false);
    assert.equal(result.code, "check_failed");
  } finally {
    await harness.stop();
  }
});

test("hosts can join without signing up; players cannot control the game or open the screen", async () => {
  const harness = await startServer();
  try {
    const host = harness.client(HOST);
    await host.opened();
    const joined = await host.emit("quiz:join", { sessionId: SESSION_ID, mode: "screen" });
    assert.equal(joined.ok, true);
    assert.equal(joined.role, "host");

    const alice = harness.client(ALICE);
    await alice.opened();
    assert.equal((await alice.emit("quiz:join", { sessionId: SESSION_ID, mode: "screen" })).code, "forbidden");
    await alice.emit("quiz:join", { sessionId: SESSION_ID });
    assert.equal((await alice.emit("quiz:host", { action: "start" })).code, "forbidden");
  } finally {
    await harness.stop();
  }
});

test("a full quiz: lobby, live question, private answers, reveal, finish and saving", async () => {
  const harness = await startServer();
  try {
    const host = harness.client(HOST);
    const alice = harness.client(ALICE);
    const bob = harness.client(BOB);
    await Promise.all([host.opened(), alice.opened(), bob.opened()]);

    await host.emit("quiz:join", { sessionId: SESSION_ID });
    await alice.emit("quiz:join", { sessionId: SESSION_ID });
    await bob.emit("quiz:join", { sessionId: SESSION_ID });

    const lobby = await host.waitFor((payload) => payload.state.players.length === 2, "both players in the lobby");
    assert.deepEqual(lobby.state.players.map((player) => player.name).sort(), ["Alice", "Bob"]);

    assert.equal((await host.emit("quiz:host", { action: "start" })).ok, true);
    assert.equal(harness.store.calls.started.length, 1);

    const live = await alice.waitFor((payload) => payload.state.phase === "question", "the question to open");
    assert.ok(live.state.timer.endsAt > live.state.serverNow);
    assert.ok(!JSON.stringify(live).includes('"correct"'), "players must not receive the solution");
    assert.ok(!JSON.stringify(live).includes("Because it is."));

    const first = await alice.emit("quiz:answer", { response: 0 });
    assert.equal(first.ok, true);
    assert.equal(first.you.response, 0);
    assert.equal((await alice.emit("quiz:answer", { response: 1 })).code, "already_answered");
    assert.equal((await host.emit("quiz:answer", { response: 0 })).code, "not_playing");

    await bob.emit("quiz:answer", { response: 1 });

    const aliceReveal = await alice.waitFor((payload) => payload.state.phase === "reveal", "the reveal");
    const bobReveal = await bob.waitFor((payload) => payload.state.phase === "reveal", "the reveal");
    assert.deepEqual(aliceReveal.state.reveal.correctIds, [0]);
    assert.equal(aliceReveal.you.result.verdict, "correct");
    assert.equal(bobReveal.you.result.verdict, "wrong");
    assert.equal(aliceReveal.state.standings[0].name, "Alice");
    assert.equal(aliceReveal.you.response, undefined);

    assert.equal(harness.store.calls.locked.length, 1);
    assert.equal(harness.store.calls.locked[0][1].results.length, 2);

    assert.equal((await host.emit("quiz:host", { action: "next" })).ok, true);
    const done = await bob.waitFor((payload) => payload.state.phase === "finished", "the final screen");
    assert.equal(done.state.standings[0].name, "Alice");
    assert.equal(harness.store.calls.finished.length, 1);
    assert.equal(harness.store.calls.finished[0][1].cancelled, false);
  } finally {
    await harness.stop();
  }
});

test("opening a second tab replaces the first for the same player", async () => {
  const harness = await startServer();
  try {
    const first = harness.client(ALICE);
    await first.opened();
    await first.emit("quiz:join", { sessionId: SESSION_ID });

    const second = harness.client(ALICE);
    await second.opened();
    const joined = await second.emit("quiz:join", { sessionId: SESSION_ID });
    assert.equal(joined.ok, true);

    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.deepEqual(first.events, ["quiz:replaced"]);
    assert.equal(joined.state.players.length, 1);
  } finally {
    await harness.stop();
  }
});

test("kicking a player removes them and blocks them from coming back", async () => {
  const harness = await startServer();
  try {
    const host = harness.client(HOST);
    const alice = harness.client(ALICE);
    await Promise.all([host.opened(), alice.opened()]);
    await host.emit("quiz:join", { sessionId: SESSION_ID });
    await alice.emit("quiz:join", { sessionId: SESSION_ID });

    const result = await host.emit("quiz:host", { action: "kick", discordId: ALICE });
    assert.equal(result.ok, true);
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.deepEqual(alice.events, ["quiz:removed"]);

    const again = await alice.emit("quiz:join", { sessionId: SESSION_ID });
    assert.equal(again.code, "removed");
  } finally {
    await harness.stop();
  }
});

test("cancelling ends the quiz for everyone and saves it as cancelled", async () => {
  const harness = await startServer();
  try {
    const host = harness.client(HOST);
    const alice = harness.client(ALICE);
    await Promise.all([host.opened(), alice.opened()]);
    await host.emit("quiz:join", { sessionId: SESSION_ID });
    await alice.emit("quiz:join", { sessionId: SESSION_ID });

    await host.emit("quiz:host", { action: "cancel" });
    const ended = await alice.waitFor((payload) => payload.state.phase === "finished", "the quiz to end");
    assert.equal(ended.state.cancelled, true);
    assert.equal(harness.store.calls.finished[0][1].cancelled, true);
  } finally {
    await harness.stop();
  }
});

test("the server clock can be read for timer sync", async () => {
  const harness = await startServer();
  try {
    const alice = harness.client(ALICE);
    await alice.opened();
    const { serverNow } = await alice.emit("quiz:ping");
    assert.ok(Math.abs(serverNow - Date.now()) < 2000);
  } finally {
    await harness.stop();
  }
});

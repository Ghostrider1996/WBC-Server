process.env.SESSION_SECRET = "test-session-secret";

const test = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const { createQuizRouter } = require("../src/controllers/quizController");
const { signSessionToken } = require("../src/services/sessionToken");

const HOST = "111111111111111111";
const PLAYER = "222222222222222222";
const OTHER = "333333333333333333";
const SESSION_ID = "11111111-1111-4111-8111-111111111111";

function session(status = "lobby") {
  return {
    id: SESSION_ID,
    title: "Quiz night",
    raidHelperEventId: "event-1",
    hostDiscordId: HOST,
    hostName: "Host",
    status,
    rounds: [{ type: "single_choice", count: 2 }],
    settings: {},
    createdAt: "2026-10-25T00:00:00.000Z",
    startedAt: null,
    endedAt: null,
  };
}

function createHarness({ getEvent, cancelQuiz } = {}) {
  const calls = [];
  const store = {
    listOpenSessions: async () => [session("live")],
    readyTypeCounts: async () => [{ type: "single_choice", label: "One option", count: 6 }],
    createSession: async (input) => {
      calls.push(["create", input]);
      return session();
    },
    getSession: async (id) => (id === SESSION_ID ? session() : null),
    getResults: async (id) => (id === SESSION_ID
      ? { session: session("ended"), players: [{ discordId: PLAYER, name: "P", score: 10, correctCount: 1, totalTimeMs: 100, rank: 1 }] }
      : null),
    wasPlayer: async (_id, discordId) => discordId === PLAYER,
  };

  const app = express();
  app.use(express.json());
  app.use("/api", createQuizRouter({
    store,
    trivia: { isTriviaAdmin: async (id) => id === HOST },
    isOwner: () => false,
    getEvent: getEvent || (async (id) => {
      if (id !== "event-1") {
        const error = new Error("That raid event was not found.");
        error.statusCode = 404;
        throw error;
      }
      return { title: "Friday raid" };
    }),
    cancelQuiz: cancelQuiz || (async (id) => { calls.push(["cancel", id]); }),
  }));

  return new Promise((resolve) => {
    const server = app.listen(0, "127.0.0.1", () => {
      resolve({
        calls,
        base: `http://127.0.0.1:${server.address().port}/api`,
        close: () => new Promise((done) => server.close(done)),
      });
    });
  });
}

function auth(discordId) {
  return { Authorization: `Bearer ${signSessionToken(discordId)}` };
}

async function call(harness, method, path, { as, body } = {}) {
  const headers = as ? auth(as) : {};
  const init = { method, headers };
  if (body !== undefined) {
    headers["Content-Type"] = "application/json";
    init.body = JSON.stringify(body);
  }
  const response = await fetch(`${harness.base}${path}`, init);
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null };
}

test("every quiz route needs a Discord session", async () => {
  const harness = await createHarness();
  try {
    assert.equal((await call(harness, "GET", "/quiz/sessions/active")).status, 200);
    assert.equal((await call(harness, "POST", "/quiz/sessions", { body: {} })).status, 401);
  } finally {
    await harness.close();
  }
});

test("only hosts can see types or create a quiz", async () => {
  const harness = await createHarness();
  try {
    assert.equal((await call(harness, "GET", "/quiz/types", { as: OTHER })).status, 403);
    assert.equal((await call(harness, "POST", "/quiz/sessions", {
      as: OTHER,
      body: { raidHelperEventId: "event-1", rounds: [{ type: "single_choice", count: 1 }] },
    })).status, 403);

    const types = await call(harness, "GET", "/quiz/types", { as: HOST });
    assert.equal(types.status, 200);
    assert.deepEqual(types.body.types, [{ type: "single_choice", label: "One option", count: 6 }]);
  } finally {
    await harness.close();
  }
});

test("creating a quiz needs a real event and valid rounds", async () => {
  const harness = await createHarness();
  try {
    const missing = await call(harness, "POST", "/quiz/sessions", { as: HOST, body: { rounds: [{ type: "single_choice", count: 1 }] } });
    assert.equal(missing.status, 400);
    assert.equal(missing.body.fields.raidHelperEventId, "Choose the event this quiz is for.");

    const unknown = await call(harness, "POST", "/quiz/sessions", {
      as: HOST,
      body: { raidHelperEventId: "nope", rounds: [{ type: "single_choice", count: 1 }] },
    });
    assert.equal(unknown.status, 404);

    const created = await call(harness, "POST", "/quiz/sessions", {
      as: HOST,
      body: { raidHelperEventId: "event-1", title: "  Night  ", rounds: [{ type: "single_choice", count: 2 }] },
    });
    assert.equal(created.status, 201);
    assert.equal(created.body.session.id, SESSION_ID);
    assert.equal(harness.calls[0][1].title, "Night");
    assert.deepEqual(harness.calls[0][1].rounds, [{ type: "single_choice", count: 2 }]);
  } finally {
    await harness.close();
  }
});

test("a down Raid Helper lookup fails closed when creating a quiz", async () => {
  const error = new Error("The raid event could not be loaded.");
  error.statusCode = 502;
  const harness = await createHarness({ getEvent: async () => { throw error; } });
  try {
    const result = await call(harness, "POST", "/quiz/sessions", {
      as: HOST,
      body: { raidHelperEventId: "event-1", rounds: [{ type: "single_choice", count: 1 }] },
    });
    assert.equal(result.status, 502);
  } finally {
    await harness.close();
  }
});

test("signed-in users can see open quizzes so event cards can link them", async () => {
  const harness = await createHarness();
  try {
    const result = await call(harness, "GET", "/quiz/sessions/active", { as: OTHER });
    assert.equal(result.status, 200);
    assert.equal(result.body.sessions[0].id, SESSION_ID);
    assert.equal(result.body.sessions[0].raidHelperEventId, "event-1");
    assert.equal(result.body.sessions[0].rounds, undefined);
  } finally {
    await harness.close();
  }
});

test("hosts can cancel; results are only for hosts and people who played", async () => {
  const harness = await createHarness();
  try {
    assert.equal((await call(harness, "POST", `/quiz/sessions/${SESSION_ID}/cancel`, { as: OTHER })).status, 403);

    const cancelled = await call(harness, "POST", `/quiz/sessions/${SESSION_ID}/cancel`, { as: HOST });
    assert.equal(cancelled.status, 200);
    assert.deepEqual(harness.calls[0], ["cancel", SESSION_ID]);

    assert.equal((await call(harness, "GET", `/quiz/sessions/${SESSION_ID}/results`, { as: OTHER })).status, 404);

    const player = await call(harness, "GET", `/quiz/sessions/${SESSION_ID}/results`, { as: PLAYER });
    assert.equal(player.status, 200);
    assert.equal(player.body.players[0].score, 10);

    const missing = await call(harness, "GET", "/quiz/sessions/not-a-uuid/results", { as: HOST });
    assert.equal(missing.status, 404);
  } finally {
    await harness.close();
  }
});

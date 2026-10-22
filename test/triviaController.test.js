process.env.SESSION_SECRET = "test-session-secret";

const test = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const { createTriviaRouter, triviaErrorHandler } = require("../src/controllers/triviaController");
const { signSessionToken } = require("../src/services/sessionToken");
const { OWNER_DISCORD_ID } = require("../src/services/adminService");

const ADMIN_ID = "111111111111111111";
const USER_ID = "222222222222222222";

const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64)]);

function createHarness() {
  const calls = [];
  const record = (name, result) => (...args) => {
    calls.push([name, ...args]);
    return typeof result === "function" ? result(...args) : result;
  };

  const service = {
    isTriviaAdmin: record("isTriviaAdmin", async (id) => id === ADMIN_ID),
    listTriviaAdmins: record("listTriviaAdmins", async () => ({ admins: [] })),
    addTriviaAdmin: record("addTriviaAdmin", async () => ({ admins: [{ discordId: ADMIN_ID }] })),
    removeTriviaAdmin: record("removeTriviaAdmin", async () => ({ admins: [] })),
    listQuestions: record("listQuestions", async () => ({ questions: [], total: 0 })),
    getQuestion: record("getQuestion", async () => null),
    createQuestion: record("createQuestion", async (value) => ({ id: "new", ...value })),
    replaceQuestion: record("replaceQuestion", async () => null),
    deleteQuestion: record("deleteQuestion", async () => false),
    duplicateQuestion: record("duplicateQuestion", async () => null),
    listCategories: record("listCategories", async () => ({ categories: [] })),
    removeUnreferencedMedia: record("removeUnreferencedMedia", async () => {}),
  };

  const s3 = {
    uploadTriviaMedia: record("uploadTriviaMedia", async ({ kind, buffer, mimeType }) => ({
      key: "trivia/test.jpg",
      mimeType,
      size: buffer.length,
      url: `https://signed.example/${kind}`,
      expiresAt: "2030-01-01T00:00:00.000Z",
    })),
  };

  const app = express();
  app.use(express.json({ limit: "2mb" }));
  app.use("/api", createTriviaRouter({ service, s3 }));
  app.use("/api", (_req, res) => res.status(404).json({ reason: "not found", status: "failed" }));
  app.use("/api/trivia", triviaErrorHandler);

  return new Promise((resolve) => {
    const server = app.listen(0, "127.0.0.1", () => {
      const base = `http://127.0.0.1:${server.address().port}/api`;
      resolve({
        calls,
        service,
        s3,
        base,
        close: () => new Promise((done) => server.close(done)),
      });
    });
  });
}

function auth(discordId) {
  return { Authorization: `Bearer ${signSessionToken(discordId)}` };
}

async function call(harness, method, path, { as, body, headers = {}, raw } = {}) {
  const init = { method, headers: { ...(as ? auth(as) : {}), ...headers } };
  if (raw !== undefined) {
    init.body = raw;
  } else if (body !== undefined && method !== "GET") {
    init.headers["Content-Type"] = "application/json";
    init.body = JSON.stringify(body);
  }
  const response = await fetch(`${harness.base}${path}`, init);
  const text = await response.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = text;
  }
  return { status: response.status, json };
}

const routes = [
  ["GET", "/trivia/access"],
  ["GET", "/trivia/admins"],
  ["POST", "/trivia/admins"],
  ["DELETE", "/trivia/admins/333333333333333333"],
  ["GET", "/trivia/questions"],
  ["GET", "/trivia/questions/5f6f2c52-1d0b-4a1f-9f71-0a0b0c0d0e0f"],
  ["POST", "/trivia/questions"],
  ["PUT", "/trivia/questions/5f6f2c52-1d0b-4a1f-9f71-0a0b0c0d0e0f"],
  ["DELETE", "/trivia/questions/5f6f2c52-1d0b-4a1f-9f71-0a0b0c0d0e0f"],
  ["POST", "/trivia/questions/5f6f2c52-1d0b-4a1f-9f71-0a0b0c0d0e0f/duplicate"],
  ["GET", "/trivia/categories"],
  ["POST", "/trivia/media"],
  ["DELETE", "/trivia/media"],
];
const ownerOnly = new Set(["/trivia/admins", "/trivia/admins/333333333333333333"]);

test("every route rejects missing, malformed and tampered tokens with 401", async (t) => {
  const harness = await createHarness();
  t.after(harness.close);

  const tampered = `${signSessionToken(OWNER_DISCORD_ID)}x`;
  const expired = signSessionToken(OWNER_DISCORD_ID, -1000);

  for (const [method, path] of routes) {
    for (const headers of [{}, { Authorization: "Bearer nope" }, { Authorization: `Bearer ${tampered}` }, { Authorization: `Bearer ${expired}` }, { Authorization: signSessionToken(OWNER_DISCORD_ID) }]) {
      const result = await call(harness, method, path, { headers, body: {} });
      assert.equal(result.status, 401, `${method} ${path}`);
      assert.equal(result.json.status, "failed");
      assert.equal(typeof result.json.reason, "string");
    }
  }
  assert.equal(harness.calls.length, 0, "no service call before auth succeeds");
});

test("a discordId in the body or query never grants access", async (t) => {
  const harness = await createHarness();
  t.after(harness.close);

  const result = await call(harness, "GET", `/trivia/questions?discordId=${OWNER_DISCORD_ID}`, { as: USER_ID });
  assert.equal(result.status, 403);
  const post = await call(harness, "POST", "/trivia/questions", { as: USER_ID, body: { discordId: OWNER_DISCORD_ID } });
  assert.equal(post.status, 403);
});

test("non trivia admins get 403 on admin routes but 200 on /trivia/access", async (t) => {
  const harness = await createHarness();
  t.after(harness.close);

  const access = await call(harness, "GET", "/trivia/access", { as: USER_ID });
  assert.deepEqual([access.status, access.json], [200, { isTriviaAdmin: false, isOwner: false }]);

  for (const [method, path] of routes.filter(([, path]) => path !== "/trivia/access")) {
    const result = await call(harness, method, path, { as: USER_ID, body: {} });
    assert.equal(result.status, 403, `${method} ${path}`);
    assert.equal(result.json.status, "failed");
  }
  assert.equal(harness.calls.filter(([name]) => name !== "isTriviaAdmin").length, 0);
});

test("trivia admins are not owners: owner-only routes return 403, others pass", async (t) => {
  const harness = await createHarness();
  t.after(harness.close);

  const access = await call(harness, "GET", "/trivia/access", { as: ADMIN_ID });
  assert.deepEqual(access.json, { isTriviaAdmin: true, isOwner: false });

  for (const path of ownerOnly) {
    const method = path.includes("333") ? "DELETE" : "GET";
    assert.equal((await call(harness, method, path, { as: ADMIN_ID })).status, 403, path);
  }
  assert.equal((await call(harness, "GET", "/trivia/questions", { as: ADMIN_ID })).status, 200);
  assert.equal((await call(harness, "GET", "/trivia/categories", { as: ADMIN_ID })).status, 200);
});

test("the owner is always a trivia admin without a database lookup", async (t) => {
  const harness = await createHarness();
  t.after(harness.close);

  const access = await call(harness, "GET", "/trivia/access", { as: OWNER_DISCORD_ID });
  assert.deepEqual(access.json, { isTriviaAdmin: true, isOwner: true });

  assert.equal((await call(harness, "GET", "/trivia/questions", { as: OWNER_DISCORD_ID })).status, 200);
  assert.equal((await call(harness, "GET", "/trivia/admins", { as: OWNER_DISCORD_ID })).status, 200);

  const added = await call(harness, "POST", "/trivia/admins", { as: OWNER_DISCORD_ID, body: { discordId: ADMIN_ID } });
  assert.equal(added.status, 201);
  assert.deepEqual(harness.calls.find(([name]) => name === "addTriviaAdmin").slice(1), [ADMIN_ID, OWNER_DISCORD_ID]);

  const removed = await call(harness, "DELETE", `/trivia/admins/${ADMIN_ID}`, { as: OWNER_DISCORD_ID });
  assert.equal(removed.status, 200);
});

test("database failures while checking access return a generic 500", async (t) => {
  const harness = await createHarness();
  t.after(harness.close);
  harness.service.isTriviaAdmin = async () => {
    throw new Error("connection refused at 10.0.0.5:5432");
  };
  const originalError = console.error;
  console.error = () => {};
  t.after(() => { console.error = originalError; });

  const result = await call(harness, "GET", "/trivia/questions", { as: USER_ID });
  assert.equal(result.status, 500);
  assert.deepEqual(Object.keys(result.json).sort(), ["reason", "status"]);
  assert.doesNotMatch(result.json.reason, /10\.0\.0\.5|connection/);
});

test("question routes: validation errors carry fields, bad ids are 404, missing rows are 404", async (t) => {
  const harness = await createHarness();
  t.after(harness.close);

  const invalid = await call(harness, "POST", "/trivia/questions", { as: ADMIN_ID, body: { type: "single_choice", prompt: "p", category: "c", answer: { options: [] } } });
  assert.equal(invalid.status, 400);
  assert.equal(invalid.json.status, "failed");
  assert.ok(invalid.json.fields["answer.options"]);

  const created = await call(harness, "POST", "/trivia/questions", {
    as: ADMIN_ID,
    body: { type: "true_false", prompt: " Is it? ", category: "c", answer: { correct: true }, createdByDiscordId: "spoofed" },
  });
  assert.equal(created.status, 201);
  assert.equal(created.json.prompt, "Is it?");
  const createCall = harness.calls.find(([name]) => name === "createQuestion");
  assert.equal(createCall[2], ADMIN_ID, "creator comes from the session");

  const badId = await call(harness, "GET", "/trivia/questions/not-a-uuid", { as: ADMIN_ID });
  assert.equal(badId.status, 404);

  const id = "5f6f2c52-1d0b-4a1f-9f71-0a0b0c0d0e0f";
  assert.equal((await call(harness, "GET", `/trivia/questions/${id}`, { as: ADMIN_ID })).status, 404);
  assert.equal((await call(harness, "DELETE", `/trivia/questions/${id}`, { as: ADMIN_ID })).status, 404);
  assert.equal((await call(harness, "POST", `/trivia/questions/${id}/duplicate`, { as: ADMIN_ID })).status, 404);
  const put = await call(harness, "PUT", `/trivia/questions/${id}`, {
    as: ADMIN_ID,
    body: { type: "true_false", prompt: "p", category: "c", answer: { correct: false } },
  });
  assert.equal(put.status, 404);
  assert.equal((await call(harness, "PUT", `/trivia/questions/${id}`, { as: ADMIN_ID, body: {} })).status, 400);

  harness.service.deleteQuestion = async () => true;
  const deleted = await call(harness, "DELETE", `/trivia/questions/${id}`, { as: ADMIN_ID });
  assert.deepEqual([deleted.status, deleted.json], [200, { status: "deleted" }]);

  harness.service.duplicateQuestion = async () => ({ id: "copy", status: "draft" });
  const duplicate = await call(harness, "POST", `/trivia/questions/${id}/duplicate`, { as: ADMIN_ID });
  assert.equal(duplicate.status, 201);
});

test("malformed JSON bodies return the JSON error shape without a stack trace", async (t) => {
  const harness = await createHarness();
  t.after(harness.close);

  const result = await call(harness, "POST", "/trivia/questions", {
    as: ADMIN_ID,
    headers: { "Content-Type": "application/json" },
    raw: "{not json",
  });
  assert.equal(result.status, 400);
  assert.deepEqual(result.json, { reason: "The request body is not valid JSON.", status: "failed" });
});

test("service errors keep their status and fields; unexpected ones are generic", async (t) => {
  const harness = await createHarness();
  t.after(harness.close);
  const originalError = console.error;
  console.error = () => {};
  t.after(() => { console.error = originalError; });

  harness.service.removeTriviaAdmin = async () => {
    throw Object.assign(new Error("The owner is always a trivia admin and cannot be removed."), { statusCode: 400 });
  };
  const owner = await call(harness, "DELETE", `/trivia/admins/${OWNER_DISCORD_ID}`, { as: OWNER_DISCORD_ID });
  assert.equal(owner.status, 400);
  assert.match(owner.json.reason, /cannot be removed/);

  harness.service.listCategories = async () => {
    throw new Error('relation "trivia_questions" does not exist');
  };
  const failure = await call(harness, "GET", "/trivia/categories", { as: ADMIN_ID });
  assert.equal(failure.status, 500);
  assert.doesNotMatch(failure.json.reason, /relation/);
});

test("DELETE /trivia/media validates the key and maps references to 409", async (t) => {
  const harness = await createHarness();
  t.after(harness.close);

  for (const key of [undefined, "news/a.png", "trivia/../x", "", 5]) {
    const result = await call(harness, "DELETE", "/trivia/media", { as: ADMIN_ID, body: { key } });
    assert.equal(result.status, 400, String(key));
    assert.ok(result.json.fields.key);
  }

  const ok = await call(harness, "DELETE", "/trivia/media", { as: ADMIN_ID, body: { key: "trivia/a.png" } });
  assert.deepEqual([ok.status, ok.json], [200, { status: "deleted" }]);

  harness.service.removeUnreferencedMedia = async () => {
    throw Object.assign(new Error("That media file is used by a question and cannot be removed."), { statusCode: 409 });
  };
  const conflict = await call(harness, "DELETE", "/trivia/media", { as: ADMIN_ID, body: { key: "trivia/a.png" } });
  assert.equal(conflict.status, 409);
});

function form(entries) {
  const data = new FormData();
  for (const [name, value, filename] of entries) {
    if (value instanceof Buffer) data.append(name, new Blob([value]), filename || "upload.bin");
    else data.append(name, value);
  }
  return data;
}

test("POST /trivia/media uploads a verified file and returns UploadedMedia", async (t) => {
  const harness = await createHarness();
  t.after(harness.close);

  const result = await call(harness, "POST", "/trivia/media", {
    as: ADMIN_ID,
    raw: form([["kind", "image"], ["file", JPEG, "photo.jpg"]]),
  });
  assert.equal(result.status, 201, JSON.stringify(result.json));
  assert.deepEqual(result.json, {
    key: "trivia/test.jpg",
    kind: "image",
    mimeType: "image/jpeg",
    size: JPEG.length,
    url: "https://signed.example/image",
    expiresAt: "2030-01-01T00:00:00.000Z",
  });

  const fileFirst = await call(harness, "POST", "/trivia/media", {
    as: ADMIN_ID,
    raw: form([["file", JPEG, "photo.jpg"], ["kind", "image"]]),
  });
  assert.equal(fileFirst.status, 201);
});

test("POST /trivia/media ignores the claimed MIME type and checks the bytes", async (t) => {
  const harness = await createHarness();
  t.after(harness.close);

  const data = new FormData();
  data.append("kind", "image");
  data.append("file", new Blob([Buffer.from("<svg onload=alert(1)></svg>".padEnd(64))], { type: "image/png" }), "x.png");
  const spoofed = await call(harness, "POST", "/trivia/media", { as: ADMIN_ID, raw: data });
  assert.equal(spoofed.status, 415);
  assert.ok(spoofed.json.fields.file);

  const wrongKind = await call(harness, "POST", "/trivia/media", {
    as: ADMIN_ID,
    raw: form([["kind", "audio"], ["file", JPEG, "photo.jpg"]]),
  });
  assert.equal(wrongKind.status, 415);
  assert.equal(harness.calls.filter(([name]) => name === "uploadTriviaMedia").length, 0);
});

test("POST /trivia/media rejects missing or invalid kind and missing file", async (t) => {
  const harness = await createHarness();
  t.after(harness.close);

  const noKind = await call(harness, "POST", "/trivia/media", { as: ADMIN_ID, raw: form([["file", JPEG, "a.jpg"]]) });
  assert.equal(noKind.status, 400);
  assert.ok(noKind.json.fields.kind);

  const badKind = await call(harness, "POST", "/trivia/media", { as: ADMIN_ID, raw: form([["kind", "document"], ["file", JPEG, "a.jpg"]]) });
  assert.equal(badKind.status, 400);

  const noFile = await call(harness, "POST", "/trivia/media", { as: ADMIN_ID, raw: form([["kind", "image"]]) });
  assert.equal(noFile.status, 400);
  assert.ok(noFile.json.fields.file);

  const json = await call(harness, "POST", "/trivia/media", { as: ADMIN_ID, body: { kind: "image" } });
  assert.equal(json.status, 400);
});

test("POST /trivia/media enforces the per-kind size limit (kind sent first aborts while streaming)", async (t) => {
  const harness = await createHarness();
  t.after(harness.close);

  const big = Buffer.concat([JPEG, Buffer.alloc(8 * 1024 * 1024)]);
  const early = await call(harness, "POST", "/trivia/media", { as: ADMIN_ID, raw: form([["kind", "image"], ["file", big, "big.jpg"]]) });
  assert.equal(early.status, 413);
  assert.match(early.json.reason, /Image files must be 8MB or smaller/);

  const late = await call(harness, "POST", "/trivia/media", { as: ADMIN_ID, raw: form([["file", big, "big.jpg"], ["kind", "image"]]) });
  assert.equal(late.status, 413);

  const audio = Buffer.concat([Buffer.from("ID3"), Buffer.alloc(26 * 1024 * 1024)]);
  const tooBigAudio = await call(harness, "POST", "/trivia/media", { as: ADMIN_ID, raw: form([["kind", "audio"], ["file", audio, "a.mp3"]]) });
  assert.equal(tooBigAudio.status, 413);
  assert.match(tooBigAudio.json.reason, /Audio files must be 25MB or smaller/);
  assert.equal(harness.calls.filter(([name]) => name === "uploadTriviaMedia").length, 0);
});

test("POST /trivia/media is gated by auth before any body is buffered", async (t) => {
  const harness = await createHarness();
  t.after(harness.close);

  const anonymous = await call(harness, "POST", "/trivia/media", { raw: form([["kind", "image"], ["file", JPEG, "a.jpg"]]) });
  assert.equal(anonymous.status, 401);
  const user = await call(harness, "POST", "/trivia/media", { as: USER_ID, raw: form([["kind", "image"], ["file", JPEG, "a.jpg"]]) });
  assert.equal(user.status, 403);
});

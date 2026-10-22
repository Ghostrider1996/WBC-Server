// Runs against a throwaway Postgres only: TRIVIA_TEST_DATABASE_URL=postgres://... node --test
// The test stubs ../src/db/pool (the app pool requires TLS for Neon) and S3, then drives the real
// router and service over HTTP. It creates and drops its own schema objects in the given database.
process.env.SESSION_SECRET = "test-session-secret";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const databaseUrl = process.env.TRIVIA_TEST_DATABASE_URL;
const skip = databaseUrl ? false : "set TRIVIA_TEST_DATABASE_URL to run the Postgres integration test";

test("trivia service and routes against Postgres", { skip }, async (t) => {
  const { Pool } = require("pg");
  const pool = new Pool({ connectionString: databaseUrl, max: 4 });
  const poolPath = require.resolve("../src/db/pool");
  require.cache[poolPath] = {
    id: poolPath,
    filename: poolPath,
    loaded: true,
    exports: { query: (text, params) => pool.query(text, params), getPool: () => pool, closePool: () => pool.end() },
  };

  const s3 = require("../src/services/s3Service");
  const objects = new Map();
  const log = [];
  let counter = 0;
  Object.assign(s3, {
    headTriviaObject: async (key) => objects.get(key) || null,
    getTriviaSignedUrl: async (key) => ({ url: `https://signed.example/${key}?sig=1`, expiresAt: "2030-01-01T00:00:00.000Z" }),
    deleteTriviaObject: async (key) => { log.push(["delete", key]); objects.delete(key); },
    copyTriviaObject: async (key) => {
      if (!objects.has(key)) throw Object.assign(new Error("The media file for this question is missing."), { statusCode: 409 });
      const target = `trivia/copy-${++counter}${key.slice(key.lastIndexOf("."))}`;
      objects.set(target, objects.get(key));
      log.push(["copy", key, target]);
      return target;
    },
  });

  const express = require("express");
  const { createTriviaRouter, triviaErrorHandler } = require("../src/controllers/triviaController");
  const { signSessionToken } = require("../src/services/sessionToken");
  const { OWNER_DISCORD_ID } = require("../src/services/adminService");

  const schemaSql = fs.readFileSync(path.resolve(__dirname, "../src/db/schema.sql"), "utf8");
  await pool.query(schemaSql);
  await pool.query(schemaSql);
  await pool.query("TRUNCATE trivia_questions, trivia_admins");

  const app = express();
  app.use(express.json({ limit: "2mb" }));
  app.use("/api", createTriviaRouter());
  app.use("/api/trivia", triviaErrorHandler);
  const server = await new Promise((resolve) => { const s = app.listen(0, "127.0.0.1", () => resolve(s)); });
  t.after(async () => { await new Promise((done) => server.close(done)); await pool.end(); });
  const base = `http://127.0.0.1:${server.address().port}/api`;

  const ADMIN = "444444444444444444";
  const OUTSIDER = "555555555555555555";
  const api = async (method, url, as, body) => {
    const response = await fetch(`${base}${url}`, {
      method,
      headers: { Authorization: `Bearer ${signSessionToken(as)}`, ...(body ? { "Content-Type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: response.status, json: await response.json() };
  };

  const tf = (extra = {}) => ({ type: "true_false", prompt: "Is the sky blue?", category: "General", answer: { correct: true }, ...extra });

  await t.test("admins: owner manages the list, usernames resolve, idempotent, owner protected", async () => {
    await pool.query("DELETE FROM users WHERE discord_id = $1", [ADMIN]);
    await pool.query("INSERT INTO users (discord_id, username) VALUES ($1, 'Moderator')", [ADMIN]);

    assert.equal((await api("GET", "/trivia/admins", ADMIN)).status, 403);
    assert.deepEqual((await api("GET", "/trivia/admins", OWNER_DISCORD_ID)).json, { admins: [] });

    const added = await api("POST", "/trivia/admins", OWNER_DISCORD_ID, { discordId: ADMIN });
    assert.equal(added.status, 201);
    assert.equal(added.json.admins.length, 1);
    assert.deepEqual(Object.keys(added.json.admins[0]).sort(), ["addedByDiscordId", "createdAt", "discordId", "username"]);
    assert.equal(added.json.admins[0].username, "Moderator");
    assert.equal(added.json.admins[0].addedByDiscordId, OWNER_DISCORD_ID);

    const again = await api("POST", "/trivia/admins", OWNER_DISCORD_ID, { discordId: ADMIN });
    assert.equal(again.status, 201);
    assert.equal(again.json.admins.length, 1);

    const unknown = await api("POST", "/trivia/admins", OWNER_DISCORD_ID, { discordId: OUTSIDER });
    assert.equal(unknown.json.admins.find((admin) => admin.discordId === OUTSIDER).username, null);
    assert.equal((await api("POST", "/trivia/admins", OWNER_DISCORD_ID, { discordId: "123" })).status, 400);
    assert.equal((await api("POST", "/trivia/admins", OWNER_DISCORD_ID, { discordId: 444444444444444444 })).status, 400);

    const ownerAdd = await api("POST", "/trivia/admins", OWNER_DISCORD_ID, { discordId: OWNER_DISCORD_ID });
    assert.equal(ownerAdd.status, 201);
    assert.equal(ownerAdd.json.admins.some((admin) => admin.discordId === OWNER_DISCORD_ID), false);
    assert.equal((await api("DELETE", `/trivia/admins/${OWNER_DISCORD_ID}`, OWNER_DISCORD_ID)).status, 400);

    assert.equal((await api("GET", "/trivia/access", ADMIN)).json.isTriviaAdmin, true);
    assert.equal((await api("GET", "/trivia/access", OUTSIDER.replace(/5/g, "6"))).json.isTriviaAdmin, false);

    const removed = await api("DELETE", `/trivia/admins/${OUTSIDER}`, OWNER_DISCORD_ID);
    assert.equal(removed.status, 200);
    assert.equal(removed.json.admins.length, 1);
    assert.equal((await api("DELETE", `/trivia/admins/not-a-number`, OWNER_DISCORD_ID)).status, 400);
  });

  await t.test("create/get for every type round-trips the normalized body", async () => {
    const o = (...e) => e.map(([text, correct]) => ({ text, correct }));
    objects.set("trivia/pic.png", { contentType: "image/png", size: 10 });
    objects.set("trivia/song.mp3", { contentType: "audio/mpeg", size: 10 });
    const bodies = [
      tf(),
      { type: "single_choice", prompt: "Pick", category: "General", answer: { options: o(["A", true], ["B", false]) } },
      { type: "multi_select", prompt: "Pick many", category: "Raids", tags: ["Raid", "pve"], answer: { options: o(["A", true], ["B", false]), scoring: "partial" } },
      { type: "number", prompt: "How many?", category: "Raids", answer: { correct: 70, partialRange: 20, min: 0, max: 100, unit: "levels" } },
      { type: "sort", prompt: "Order", category: "Lore", answer: { items: ["a", "b", "c"], startLabel: "Old" } },
      { type: "image", prompt: "Where?", category: "Lore", media: { kind: "image", source: "upload", key: "trivia/pic.png" }, answer: { format: "single_choice", options: o(["A", true], ["B", false]) } },
      { type: "audio", prompt: "Which?", category: "Music", media: { kind: "audio", source: "upload", key: "trivia/song.mp3", startSeconds: 2, endSeconds: 9 }, answer: { format: "true_false", correct: false } },
      { type: "video", prompt: "Watch", category: "Music", media: { kind: "video", source: "url", sourceUrl: "https://youtu.be/dQw4w9WgXcQ" }, answer: { format: "number", correct: 5, min: 0, max: 10 } },
    ];

    for (const body of bodies) {
      const created = await api("POST", "/trivia/questions", ADMIN, body);
      assert.equal(created.status, 201, JSON.stringify(created.json));
      const question = created.json;
      assert.match(question.id, /^[0-9a-f-]{36}$/);
      assert.equal(question.createdByDiscordId, ADMIN);
      assert.equal(question.status, "draft");
      assert.equal(question.timeLimitSeconds, 20);
      assert.equal(question.points, 1000);
      assert.ok(Date.parse(question.createdAt) && Date.parse(question.updatedAt));
      assert.equal(question.type, body.type);

      const fetched = await api("GET", `/trivia/questions/${question.id}`, ADMIN);
      assert.deepEqual(fetched.json, question);

      const resent = await api("PUT", `/trivia/questions/${question.id}`, ADMIN, question);
      assert.equal(resent.status, 200, JSON.stringify(resent.json));
      assert.deepEqual({ ...resent.json, updatedAt: 0 }, { ...question, updatedAt: 0 });
    }

    const image = (await api("GET", "/trivia/questions?type=image", ADMIN)).json.questions[0];
    assert.equal(image.media.url, "https://signed.example/trivia/pic.png?sig=1");
    assert.equal(image.media.expiresAt, "2030-01-01T00:00:00.000Z");
    assert.equal("startSeconds" in image.media, false);
    const audio = (await api("GET", "/trivia/questions?type=audio", ADMIN)).json.questions[0];
    assert.equal(audio.media.startSeconds, 2);
    assert.equal(audio.media.endSeconds, 9);
    const video = (await api("GET", "/trivia/questions?type=video", ADMIN)).json.questions[0];
    assert.deepEqual(video.media, {
      kind: "video", source: "url", sourceUrl: "https://youtu.be/dQw4w9WgXcQ",
      url: "https://www.youtube.com/embed/dQw4w9WgXcQ", expiresAt: null, startSeconds: 0, endSeconds: null,
    });

    const stored = await pool.query("SELECT media FROM trivia_questions WHERE type = 'image'");
    assert.deepEqual(stored.rows[0].media, { kind: "image", source: "upload", key: "trivia/pic.png" });
    assert.doesNotMatch(JSON.stringify((await pool.query("SELECT media FROM trivia_questions WHERE media IS NOT NULL")).rows), /signed\.example|expiresAt/);
  });

  await t.test("list: filters, search, pagination, ordering and total", async () => {
    const all = await api("GET", "/trivia/questions", ADMIN);
    assert.equal(all.json.total, 8);
    const created = all.json.questions.map((q) => Date.parse(q.createdAt));
    assert.deepEqual([...created].sort((a, b) => b - a), created);

    const page = await api("GET", "/trivia/questions?limit=3&offset=2", ADMIN);
    assert.equal(page.json.questions.length, 3);
    assert.equal(page.json.total, 8);
    assert.deepEqual(page.json.questions.map((q) => q.id), all.json.questions.slice(2, 5).map((q) => q.id));
    assert.equal((await api("GET", "/trivia/questions?limit=9999", ADMIN)).json.questions.length, 8);
    assert.equal((await api("GET", "/trivia/questions?limit=abc&offset=-4", ADMIN)).json.questions.length, 8);

    assert.equal((await api("GET", "/trivia/questions?category=Raids", ADMIN)).json.total, 2);
    assert.equal((await api("GET", "/trivia/questions?tag=RAID", ADMIN)).json.total, 1);
    assert.equal((await api("GET", "/trivia/questions?type=sort&status=draft&difficulty=medium", ADMIN)).json.total, 1);
    assert.equal((await api("GET", "/trivia/questions?status=ready", ADMIN)).json.total, 0);
    assert.equal((await api("GET", "/trivia/questions?q=sKy", ADMIN)).json.total, 1);
    assert.equal((await api("GET", "/trivia/questions?q=%25", ADMIN)).json.total, 0, "% is literal");
    assert.equal((await api("GET", "/trivia/questions?q=_", ADMIN)).json.total, 0, "_ is literal");
    assert.equal((await api("GET", "/trivia/questions?q=%27%3B%20DROP%20TABLE%20trivia_questions%3B--", ADMIN)).json.total, 0);

    const invalid = await api("GET", "/trivia/questions?type=bogus", ADMIN);
    assert.equal(invalid.status, 400);
    assert.ok(invalid.json.fields.type);

    const categories = await api("GET", "/trivia/categories", ADMIN);
    assert.deepEqual(categories.json.categories, [
      { name: "General", count: 2 }, { name: "Lore", count: 2 }, { name: "Music", count: 2 }, { name: "Raids", count: 2 },
    ]);
  });

  await t.test("explanation search matches and updated_at trigger fires", async () => {
    const created = (await api("POST", "/trivia/questions", ADMIN, tf({ explanation: "Because Rayleigh scattering", prompt: "Plain" }))).json;
    assert.equal((await api("GET", "/trivia/questions?q=rayleigh", ADMIN)).json.total, 1);
    await new Promise((resolve) => setTimeout(resolve, 15));
    const updated = (await api("PUT", `/trivia/questions/${created.id}`, ADMIN, { ...created, prompt: "Changed", status: "ready" })).json;
    assert.equal(updated.prompt, "Changed");
    assert.equal(updated.status, "ready");
    assert.equal(updated.createdAt, created.createdAt);
    assert.ok(Date.parse(updated.updatedAt) > Date.parse(created.updatedAt));
    assert.equal((await api("DELETE", `/trivia/questions/${created.id}`, ADMIN)).status, 200);
  });

  await t.test("media: missing/wrong-kind uploads are rejected, replacing deletes the old object, delete removes it", async () => {
    const o = [{ text: "A", correct: true }, { text: "B", correct: false }];
    const image = (key) => ({ type: "image", prompt: "Img", category: "Media", media: { kind: "image", source: "upload", key }, answer: { format: "single_choice", options: o } });

    const missing = await api("POST", "/trivia/questions", ADMIN, image("trivia/ghost.png"));
    assert.equal(missing.status, 400);
    assert.ok(missing.json.fields["media.key"]);

    objects.set("trivia/audio-as-image.mp3", { contentType: "audio/mpeg", size: 1 });
    const wrong = await api("POST", "/trivia/questions", ADMIN, image("trivia/audio-as-image.mp3"));
    assert.equal(wrong.status, 400);

    objects.set("trivia/a.png", { contentType: "image/png", size: 1 });
    objects.set("trivia/b.png", { contentType: "image/png", size: 1 });
    const created = (await api("POST", "/trivia/questions", ADMIN, image("trivia/a.png"))).json;

    const inUse = await api("DELETE", "/trivia/media", ADMIN, { key: "trivia/a.png" });
    assert.equal(inUse.status, 409);
    assert.equal(objects.has("trivia/a.png"), true);

    log.length = 0;
    const replaced = await api("PUT", `/trivia/questions/${created.id}`, ADMIN, image("trivia/b.png"));
    assert.equal(replaced.status, 200);
    assert.deepEqual(log, [["delete", "trivia/a.png"]]);
    assert.equal(objects.has("trivia/a.png"), false);

    const unsaved = await api("DELETE", "/trivia/media", ADMIN, { key: "trivia/b.png" });
    assert.equal(unsaved.status, 409, "b.png is referenced now");

    objects.set("trivia/orphan.png", { contentType: "image/png", size: 1 });
    const orphan = await api("DELETE", "/trivia/media", ADMIN, { key: "trivia/orphan.png" });
    assert.deepEqual([orphan.status, orphan.json], [200, { status: "deleted" }]);
    assert.equal(objects.has("trivia/orphan.png"), false);

    log.length = 0;
    const copy = await api("POST", `/trivia/questions/${created.id}/duplicate`, ADMIN);
    assert.equal(copy.status, 201);
    assert.equal(copy.json.status, "draft");
    assert.notEqual(copy.json.id, created.id);
    assert.notEqual(copy.json.media.key, "trivia/b.png");
    assert.match(copy.json.media.key, /^trivia\/copy-\d+\.png$/);
    assert.equal(copy.json.prompt, created.prompt);
    assert.equal(objects.has(copy.json.media.key), true);

    assert.equal((await api("DELETE", `/trivia/questions/${created.id}`, ADMIN)).status, 200);
    assert.equal(objects.has("trivia/b.png"), false, "original media removed");
    assert.equal(objects.has(copy.json.media.key), true, "copy survives");
    assert.equal((await api("GET", `/trivia/questions/${copy.json.id}`, ADMIN)).status, 200);
    assert.equal((await api("DELETE", `/trivia/questions/${copy.json.id}`, ADMIN)).status, 200);
    assert.equal(objects.has(copy.json.media.key), false);
  });

  await t.test("duplicate of a plain question is a draft with the caller as creator", async () => {
    const source = (await api("POST", "/trivia/questions", ADMIN, tf({ status: "ready", tags: ["x"], points: 5 }))).json;
    const copy = (await api("POST", `/trivia/questions/${source.id}/duplicate`, OWNER_DISCORD_ID)).json;
    assert.equal(copy.status, "draft");
    assert.equal(copy.createdByDiscordId, OWNER_DISCORD_ID);
    assert.equal(copy.points, 5);
    assert.deepEqual(copy.tags, ["x"]);
    assert.equal(copy.media, null);
  });

  await t.test("missing and malformed ids", async () => {
    const missing = "00000000-0000-4000-8000-000000000000";
    assert.equal((await api("GET", `/trivia/questions/${missing}`, ADMIN)).status, 404);
    assert.equal((await api("PUT", `/trivia/questions/${missing}`, ADMIN, tf())).status, 404);
    assert.equal((await api("DELETE", `/trivia/questions/${missing}`, ADMIN)).status, 404);
    assert.equal((await api("POST", `/trivia/questions/${missing}/duplicate`, ADMIN)).status, 404);
    assert.equal((await api("GET", "/trivia/questions/xyz", ADMIN)).status, 404);
  });

  await t.test("guild admins and strangers have no trivia access", async () => {
    await pool.query("INSERT INTO guild_admins (discord_id, role) VALUES ($1, 'admin') ON CONFLICT DO NOTHING", ["777777777777777777"]);
    assert.equal((await api("GET", "/trivia/questions", "777777777777777777")).status, 403);
    assert.equal((await api("GET", "/trivia/questions", OUTSIDER)).status, 403);
    await pool.query("DELETE FROM guild_admins WHERE discord_id = $1", ["777777777777777777"]);
  });
});

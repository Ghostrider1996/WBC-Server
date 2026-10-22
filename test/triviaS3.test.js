process.env.AWS_REGION = "us-east-1";
process.env.S3_BUCKET = "test-bucket";
process.env.AWS_ACCESS_KEY_ID = "AKIATEST";
process.env.AWS_SECRET_ACCESS_KEY = "secret";

const test = require("node:test");
const assert = require("node:assert/strict");
const { S3Client } = require("@aws-sdk/client-s3");
const s3 = require("../src/services/s3Service");

const sent = [];
let failWith = null;
S3Client.prototype.send = async function send(command) {
  sent.push({ name: command.constructor.name, input: command.input });
  if (failWith) throw failWith;
  return { ContentType: "image/png", ContentLength: 12 };
};

test.beforeEach(() => {
  sent.length = 0;
  failWith = null;
});

test("uploadTriviaMedia writes trivia/<uuid>.<ext> with the verified content type", async () => {
  const buffer = Buffer.alloc(32);
  const uploaded = await s3.uploadTriviaMedia({ kind: "audio", buffer, mimeType: "audio/mp4" });
  assert.match(uploaded.key, /^trivia\/[0-9a-f-]{36}\.m4a$/);
  assert.equal(uploaded.size, 32);
  assert.equal(uploaded.mimeType, "audio/mp4");
  assert.match(uploaded.url, /^https:\/\/test-bucket\.s3\.us-east-1\.amazonaws\.com\/trivia\/.+X-Amz-Signature=/);
  assert.ok(Date.parse(uploaded.expiresAt) > Date.now());
  assert.equal(sent[0].name, "PutObjectCommand");
  assert.equal(sent[0].input.ContentType, "audio/mp4");
  assert.equal(sent[0].input.Bucket, "test-bucket");

  await assert.rejects(s3.uploadTriviaMedia({ kind: "image", buffer, mimeType: "audio/mp4" }), { statusCode: 415 });
});

test("signing is on demand and refuses non-trivia keys", async () => {
  const signed = await s3.getTriviaSignedUrl("trivia/a.png");
  assert.match(signed.url, /trivia\/a\.png\?/);
  await assert.rejects(s3.getTriviaSignedUrl("news/a.png"), { statusCode: 400 });
  await assert.rejects(s3.getTriviaSignedUrl("trivia/../x"), { statusCode: 400 });
});

test("existing managed-key handling does not accept trivia keys", async () => {
  assert.equal(s3.normalizeObjectKey("trivia/a.png"), "");
  const urls = await s3.signObjectKeys(["trivia/a.png", "news/a.png"]);
  assert.deepEqual(Object.keys(urls), ["news/a.png"]);
  await s3.deleteOwnedObject("trivia/a.png");
  assert.equal(sent.filter((command) => command.name === "DeleteObjectCommand").length, 0);
});

test("copyTriviaObject copies to a fresh key with the same extension", async () => {
  const target = await s3.copyTriviaObject("trivia/source.webm");
  assert.match(target, /^trivia\/[0-9a-f-]{36}\.webm$/);
  assert.notEqual(target, "trivia/source.webm");
  assert.equal(sent[0].name, "CopyObjectCommand");
  assert.equal(sent[0].input.CopySource, "test-bucket/trivia/source.webm");
  assert.equal(sent[0].input.MetadataDirective, "COPY");

  failWith = Object.assign(new Error("gone"), { name: "NoSuchKey" });
  await assert.rejects(s3.copyTriviaObject("trivia/source.webm"), { statusCode: 409 });
  await assert.rejects(s3.copyTriviaObject("news/source.png"), { statusCode: 400 });
});

test("headTriviaObject returns null for missing objects and delete issues DeleteObject", async () => {
  assert.deepEqual(await s3.headTriviaObject("trivia/a.png"), { contentType: "image/png", size: 12 });
  failWith = Object.assign(new Error("nf"), { name: "NotFound", $metadata: { httpStatusCode: 404 } });
  assert.equal(await s3.headTriviaObject("trivia/a.png"), null);
  assert.equal(await s3.headTriviaObject("news/a.png"), null);

  failWith = null;
  sent.length = 0;
  await s3.deleteTriviaObject("trivia/a.png");
  assert.equal(sent[0].name, "DeleteObjectCommand");
  assert.equal(sent[0].input.Key, "trivia/a.png");
  sent.length = 0;
  await s3.deleteTriviaObject("news/a.png");
  assert.equal(sent.length, 0);
});

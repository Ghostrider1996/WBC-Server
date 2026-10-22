const test = require("node:test");
const assert = require("node:assert/strict");
const { isTriviaKey, normalizeVideoLink, sniffTriviaMime } = require("../src/services/triviaMedia");

const pad = (...bytes) => Buffer.concat([Buffer.from(bytes), Buffer.alloc(64)]);
const text = (value, offset = 0) => {
  const buffer = Buffer.alloc(64);
  buffer.write(value, offset, "latin1");
  return buffer;
};
const ftyp = (brand) => {
  const buffer = Buffer.alloc(64);
  buffer.writeUInt32BE(32, 0);
  buffer.write("ftyp", 4, "latin1");
  buffer.write(brand.padEnd(4, " "), 8, "latin1");
  return buffer;
};
const riff = (form) => {
  const buffer = Buffer.alloc(64);
  buffer.write("RIFF", 0, "latin1");
  buffer.write(form, 8, "latin1");
  return buffer;
};

test("sniffTriviaMime recognizes allowed formats per kind", () => {
  assert.equal(sniffTriviaMime(pad(0xff, 0xd8, 0xff, 0xe0), "image"), "image/jpeg");
  assert.equal(sniffTriviaMime(pad(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a), "image"), "image/png");
  assert.equal(sniffTriviaMime(text("GIF89a"), "image"), "image/gif");
  assert.equal(sniffTriviaMime(riff("WEBP"), "image"), "image/webp");
  assert.equal(sniffTriviaMime(ftyp("avif"), "image"), "image/avif");

  assert.equal(sniffTriviaMime(text("ID3"), "audio"), "audio/mpeg");
  assert.equal(sniffTriviaMime(pad(0xff, 0xfb, 0x90, 0x00), "audio"), "audio/mpeg");
  assert.equal(sniffTriviaMime(pad(0xff, 0xf1, 0x50, 0x80), "audio"), "audio/aac");
  assert.equal(sniffTriviaMime(text("OggS"), "audio"), "audio/ogg");
  assert.equal(sniffTriviaMime(riff("WAVE"), "audio"), "audio/wav");
  assert.equal(sniffTriviaMime(text("fLaC"), "audio"), "audio/flac");
  assert.equal(sniffTriviaMime(ftyp("M4A"), "audio"), "audio/mp4");

  assert.equal(sniffTriviaMime(ftyp("isom"), "video"), "video/mp4");
  const webm = Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x9f, 0x42, 0x86, 0x81, 0x01]), Buffer.from("B\x82\x84webm"), Buffer.alloc(32)]);
  assert.equal(sniffTriviaMime(webm, "video"), "video/webm");
});

test("sniffTriviaMime rejects mismatched kinds, spoofed and tiny files", () => {
  assert.equal(sniffTriviaMime(pad(0xff, 0xd8, 0xff, 0xe0), "video"), null);
  assert.equal(sniffTriviaMime(pad(0xff, 0xd8, 0xff, 0xe0), "audio"), null);
  assert.equal(sniffTriviaMime(riff("WAVE"), "image"), null);
  assert.equal(sniffTriviaMime(ftyp("isom"), "image"), null);
  assert.equal(sniffTriviaMime(ftyp("avif"), "video"), null);
  assert.equal(sniffTriviaMime(ftyp("heic"), "image"), null);
  assert.equal(sniffTriviaMime(ftyp("M4A"), "video"), null);
  assert.equal(sniffTriviaMime(Buffer.from("<svg xmlns='http://www.w3.org/2000/svg'></svg>"), "image"), null);
  assert.equal(sniffTriviaMime(Buffer.from("<html><script>alert(1)</script></html>"), "image"), null);
  assert.equal(sniffTriviaMime(Buffer.from([0x1a, 0x45, 0xdf, 0xa3, ...Buffer.alloc(60)]), "video"), null);
  assert.equal(sniffTriviaMime(Buffer.from([0xff, 0xd8]), "image"), null);
  assert.equal(sniffTriviaMime(pad(0xff, 0xd8, 0xff), "document"), null);
  assert.equal(sniffTriviaMime("not a buffer", "image"), null);
});

test("isTriviaKey only accepts trivia/ keys", () => {
  assert.equal(isTriviaKey("trivia/2f8f2f6e-0f3c-4f7a-bf0e-0a1b2c3d4e5f.png"), true);
  for (const key of ["news/a.png", "gallery/a.png", "soundtracks/a.mp3", "trivia/", "trivia/..", "trivia/a/b", "/trivia/a.png", "trivia/a b", "trivia/a%2fb", "", null, 5]) {
    assert.equal(isTriviaKey(key), false, String(key));
  }
});

test("normalizeVideoLink rewrites YouTube and Vimeo links to embed URLs", () => {
  const youtube = "https://www.youtube.com/embed/dQw4w9WgXcQ";
  for (const link of [
    "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
    "https://youtube.com/watch?v=dQw4w9WgXcQ&t=30s",
    "https://m.youtube.com/watch?v=dQw4w9WgXcQ",
    "https://youtu.be/dQw4w9WgXcQ?si=abc",
    "https://www.youtube.com/embed/dQw4w9WgXcQ",
    "https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ",
    "https://www.youtube.com/shorts/dQw4w9WgXcQ",
  ]) {
    assert.equal(normalizeVideoLink(link), youtube, link);
  }
  assert.equal(normalizeVideoLink("https://vimeo.com/76979871"), "https://player.vimeo.com/video/76979871");
  assert.equal(normalizeVideoLink("https://vimeo.com/76979871/abcdef1234"), "https://player.vimeo.com/video/76979871?h=abcdef1234");
  assert.equal(normalizeVideoLink("https://player.vimeo.com/video/76979871?h=abcdef1234"), "https://player.vimeo.com/video/76979871?h=abcdef1234");
  assert.equal(normalizeVideoLink("https://vimeo.com/channels/staffpicks/76979871"), "https://player.vimeo.com/video/76979871");
});

test("normalizeVideoLink allows direct https mp4/webm only", () => {
  assert.equal(normalizeVideoLink(" https://cdn.example.com/a/b.mp4 "), "https://cdn.example.com/a/b.mp4");
  assert.equal(normalizeVideoLink("https://cdn.example.com/b.WEBM?x=1"), "https://cdn.example.com/b.WEBM?x=1");
  for (const link of [
    "http://cdn.example.com/b.mp4",
    "javascript:alert(1)//.mp4",
    "data:text/html,<script>.mp4",
    "ftp://cdn.example.com/b.mp4",
    "https://cdn.example.com/b.mp4/index.html",
    "https://cdn.example.com/b.ogv",
    "https://a:b@cdn.example.com/b.mp4",
    "https://cdn.example.com/b .mp4",
    `https://cdn.example.com/${"a".repeat(2100)}.mp4`,
    null,
    undefined,
  ]) {
    assert.equal(normalizeVideoLink(link), "", String(link));
  }
});

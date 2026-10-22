const MB = 1024 * 1024;

const TRIVIA_MEDIA_KINDS = ["image", "audio", "video"];

const TRIVIA_MEDIA_LIMITS = {
  image: 8 * MB,
  audio: 25 * MB,
  video: 80 * MB,
};

const TRIVIA_MAX_UPLOAD_BYTES = Math.max(...Object.values(TRIVIA_MEDIA_LIMITS));

const TRIVIA_MEDIA_TYPES = {
  image: {
    "image/jpeg": "jpg",
    "image/png": "png",
    "image/webp": "webp",
    "image/gif": "gif",
    "image/avif": "avif",
  },
  audio: {
    "audio/mpeg": "mp3",
    "audio/ogg": "ogg",
    "audio/wav": "wav",
    "audio/mp4": "m4a",
    "audio/aac": "aac",
    "audio/flac": "flac",
  },
  video: {
    "video/mp4": "mp4",
    "video/webm": "webm",
  },
};

const TRIVIA_KEY_PATTERN = /^trivia\/[A-Za-z0-9._-]+$/;

function isTriviaKey(value) {
  if (typeof value !== "string" || !TRIVIA_KEY_PATTERN.test(value)) return false;
  const name = value.slice("trivia/".length);
  return !/^\.+$/.test(name);
}

function ascii(buffer, start, end) {
  return buffer.toString("latin1", start, end);
}

const ISO_BMFF_NON_MEDIA_BRANDS = new Set(["avif", "avis", "heic", "heix", "hevc", "mif1", "msf1", "heim", "heis"]);

/**
 * Identify a file from its leading bytes. Returns a MIME type from the allow-list
 * for `kind`, or null when the bytes do not match any allowed format.
 */
function sniffTriviaMime(buffer, kind) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 12) return null;
  const allowed = TRIVIA_MEDIA_TYPES[kind];
  if (!allowed) return null;

  const detected = detectMime(buffer, kind);
  return detected && allowed[detected] ? detected : null;
}

function detectMime(buffer, kind) {
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return "image/jpeg";
  if (buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";

  const head6 = ascii(buffer, 0, 6);
  if (head6 === "GIF87a" || head6 === "GIF89a") return "image/gif";

  const riff = ascii(buffer, 0, 4) === "RIFF";
  if (riff && ascii(buffer, 8, 12) === "WEBP") return "image/webp";
  if (riff && ascii(buffer, 8, 12) === "WAVE") return "audio/wav";

  if (ascii(buffer, 0, 4) === "OggS") return "audio/ogg";
  if (ascii(buffer, 0, 4) === "fLaC") return "audio/flac";

  if (buffer[0] === 0x1a && buffer[1] === 0x45 && buffer[2] === 0xdf && buffer[3] === 0xa3) {
    return ascii(buffer, 0, Math.min(buffer.length, 64)).includes("webm") ? "video/webm" : null;
  }

  if (ascii(buffer, 4, 8) === "ftyp") {
    const brand = ascii(buffer, 8, 12).trim().toLowerCase();
    const compatible = ascii(buffer, 16, Math.min(buffer.length, 48)).toLowerCase();
    if (brand === "avif" || brand === "avis" || compatible.includes("avif")) {
      return kind === "image" ? "image/avif" : null;
    }
    if (ISO_BMFF_NON_MEDIA_BRANDS.has(brand)) return null;
    if (kind === "audio") return "audio/mp4";
    if (kind === "video") return brand === "m4a" || brand === "m4b" ? null : "video/mp4";
    return null;
  }

  if (ascii(buffer, 0, 3) === "ID3") return "audio/mpeg";
  if (buffer[0] === 0xff && (buffer[1] & 0xe0) === 0xe0) {
    const version = (buffer[1] >> 3) & 0x03;
    const layer = (buffer[1] >> 1) & 0x03;
    if (layer === 0 && version !== 1) return "audio/aac";
    if (layer !== 0 && version !== 1) return "audio/mpeg";
  }

  return null;
}

function parseHttpsUrl(value) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 2048 || /[\s\u0000-\u001f]/.test(trimmed)) return null;

  let url;
  try {
    url = new URL(trimmed);
  } catch {
    return null;
  }

  if (url.protocol !== "https:" || url.username || url.password || !url.hostname) return null;
  return url;
}

const YOUTUBE_HOSTS = new Set([
  "youtube.com",
  "www.youtube.com",
  "m.youtube.com",
  "music.youtube.com",
  "youtube-nocookie.com",
  "www.youtube-nocookie.com",
]);
const YOUTUBE_ID = /^[A-Za-z0-9_-]{11}$/;
const VIMEO_HOSTS = new Set(["vimeo.com", "www.vimeo.com", "player.vimeo.com"]);
const VIMEO_HASH = /^[A-Za-z0-9]{6,32}$/;

function youtubeEmbed(url) {
  const host = url.hostname.toLowerCase();
  let id = "";

  if (host === "youtu.be") {
    id = url.pathname.split("/")[1] || "";
  } else if (YOUTUBE_HOSTS.has(host)) {
    const parts = url.pathname.split("/").filter(Boolean);
    if (parts[0] === "watch" && parts.length === 1) {
      id = url.searchParams.get("v") || "";
    } else if (["embed", "shorts", "live", "v"].includes(parts[0]) && parts.length === 2) {
      id = parts[1];
    }
  }

  return YOUTUBE_ID.test(id) ? `https://www.youtube.com/embed/${id}` : "";
}

function vimeoEmbed(url) {
  const host = url.hostname.toLowerCase();
  if (!VIMEO_HOSTS.has(host)) return "";

  const parts = url.pathname.split("/").filter(Boolean);
  let id = "";
  let hash = url.searchParams.get("h") || "";

  if (host === "player.vimeo.com") {
    if (parts[0] === "video" && parts.length === 2) id = parts[1];
  } else if (parts.length === 1) {
    id = parts[0];
  } else if (parts.length === 2 && /^\d+$/.test(parts[0])) {
    id = parts[0];
    hash = parts[1];
  } else if (parts.length === 3 && parts[0] === "channels") {
    id = parts[2];
  }

  if (!/^\d{1,12}$/.test(id)) return "";
  if (hash && !VIMEO_HASH.test(hash)) return "";
  return `https://player.vimeo.com/video/${id}${hash ? `?h=${hash}` : ""}`;
}

/**
 * Turn a user supplied video link into a playable URL. YouTube and Vimeo links are
 * rewritten to their embed form; direct https .mp4/.webm links pass through.
 * Returns "" for anything else.
 */
function normalizeVideoLink(value) {
  const url = parseHttpsUrl(value);
  if (!url) return "";

  const embed = youtubeEmbed(url) || vimeoEmbed(url);
  if (embed) return embed;

  if (/\.(mp4|webm)$/i.test(url.pathname)) return url.href;
  return "";
}

module.exports = {
  TRIVIA_KEY_PATTERN,
  TRIVIA_MAX_UPLOAD_BYTES,
  TRIVIA_MEDIA_KINDS,
  TRIVIA_MEDIA_LIMITS,
  TRIVIA_MEDIA_TYPES,
  isTriviaKey,
  normalizeVideoLink,
  sniffTriviaMime,
};

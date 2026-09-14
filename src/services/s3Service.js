const { randomUUID } = require("crypto");
const { GetObjectCommand, S3Client, DeleteObjectCommand, PutObjectCommand } = require("@aws-sdk/client-s3");
const { getSignedUrl } = require("@aws-sdk/s3-request-presigner");

const ALLOWED_TYPES = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/gif": "gif",
  "image/avif": "avif",
};

const MANAGED_KEY_PATTERN = /^(news|gallery)\/[A-Za-z0-9._-]+$/;
const DEFAULT_SIGN_TTL_SECONDS = 12 * 60 * 60;
const REFRESH_SKEW_MS = 5 * 60 * 1000;
const signedUrlCache = new Map();
let s3Client;

function readS3Config() {
  return {
    region: String(process.env.AWS_REGION || "").trim(),
    bucket: String(process.env.S3_BUCKET || "").trim(),
    accessKeyId: String(process.env.AWS_ACCESS_KEY_ID || "").trim(),
    secretAccessKey: String(process.env.AWS_SECRET_ACCESS_KEY || "").trim(),
  };
}

function requireS3Config() {
  const config = readS3Config();
  if (!config.region || !config.bucket || !config.accessKeyId || !config.secretAccessKey) {
    throw Object.assign(new Error("Image storage is not configured."), { statusCode: 500 });
  }
  return config;
}

function getClient() {
  if (!s3Client) {
    const { region, accessKeyId, secretAccessKey } = requireS3Config();
    s3Client = new S3Client({
      region,
      credentials: { accessKeyId, secretAccessKey },
    });
  }
  return s3Client;
}

function signTtlSeconds() {
  const configured = Number.parseInt(process.env.S3_SIGNED_URL_TTL, 10);
  if (Number.isInteger(configured) && configured >= 60 && configured <= 7 * 24 * 60 * 60) {
    return configured;
  }
  return DEFAULT_SIGN_TTL_SECONDS;
}

function isManagedImageKey(key) {
  return typeof key === "string" && MANAGED_KEY_PATTERN.test(key);
}

function canonicalUrlFor(key) {
  const { region, bucket } = requireS3Config();
  return `https://${bucket}.s3.${region}.amazonaws.com/${key}`;
}

function ownedObjectKey(value) {
  const { region, bucket } = readS3Config();
  if (!value || typeof value !== "string" || !bucket) return "";

  const trimmed = value.trim();
  if (isManagedImageKey(trimmed)) return trimmed;

  try {
    const parsed = new URL(trimmed);
    const virtualHosts = new Set([
      `${bucket}.s3.${region}.amazonaws.com`,
      `${bucket}.s3.amazonaws.com`,
    ]);

    if (virtualHosts.has(parsed.hostname)) {
      return decodeURIComponent(parsed.pathname.replace(/^\/+/, ""));
    }

    if (parsed.hostname === `s3.${region}.amazonaws.com` || parsed.hostname === "s3.amazonaws.com") {
      const parts = parsed.pathname.replace(/^\/+/, "").split("/");
      if (parts[0] !== bucket) return "";
      return decodeURIComponent(parts.slice(1).join("/"));
    }
  } catch {
    return "";
  }

  return "";
}

function normalizeObjectKey(value) {
  const key = ownedObjectKey(value);
  return isManagedImageKey(key) ? key : "";
}

function storedMediaValue(value) {
  const key = normalizeObjectKey(value);
  if (key) return canonicalUrlFor(key);
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function buildObjectKey(folder, mimeType) {
  const extension = ALLOWED_TYPES[mimeType];
  if (!extension) {
    throw Object.assign(new Error("Only JPEG, PNG, WebP, GIF, or AVIF images are allowed."), { statusCode: 400 });
  }

  const prefix = folder === "gallery" ? "gallery" : "news";
  return `${prefix}/${randomUUID()}.${extension}`;
}

function replacementKey({ folder, mimeType, replaceUrl }) {
  const extension = ALLOWED_TYPES[mimeType];
  const existingKey = normalizeObjectKey(replaceUrl);
  const prefix = folder === "gallery" ? "gallery" : "news";

  if (existingKey && existingKey.startsWith(`${prefix}/`) && existingKey.endsWith(`.${extension}`)) {
    return existingKey;
  }

  return buildObjectKey(folder, mimeType);
}

function invalidateSignedUrl(key) {
  if (key) signedUrlCache.delete(key);
}

function toSignedMedia(entry) {
  return {
    key: entry.key,
    url: entry.url,
    expiresAt: new Date(entry.expiresAt).toISOString(),
  };
}

async function getSignedReadUrl(key, { force = false } = {}) {
  const normalizedKey = normalizeObjectKey(key);
  if (!normalizedKey) {
    throw Object.assign(new Error("A valid image key is required."), { statusCode: 400 });
  }

  const now = Date.now();
  const cached = signedUrlCache.get(normalizedKey);
  if (!force && cached && cached.expiresAt - REFRESH_SKEW_MS > now) {
    return toSignedMedia(cached);
  }

  const { bucket } = requireS3Config();
  const expiresIn = signTtlSeconds();
  const url = await getSignedUrl(
    getClient(),
    new GetObjectCommand({ Bucket: bucket, Key: normalizedKey }),
    { expiresIn },
  );

  const entry = {
    key: normalizedKey,
    url,
    expiresAt: now + expiresIn * 1000,
  };
  signedUrlCache.set(normalizedKey, entry);
  return toSignedMedia(entry);
}

async function resolveSignedMedia(value) {
  const key = normalizeObjectKey(value);
  if (!key) {
    return {
      key: "",
      url: typeof value === "string" ? value : "",
      expiresAt: null,
    };
  }

  try {
    return await getSignedReadUrl(key);
  } catch (error) {
    console.error("Signed image URL could not be created:", error.message);
    return {
      key,
      url: storedMediaValue(value) || "",
      expiresAt: null,
    };
  }
}

async function signObjectKeys(keys, { force = false } = {}) {
  const uniqueKeys = [...new Set((Array.isArray(keys) ? keys : []).map(normalizeObjectKey).filter(Boolean))].slice(0, 30);
  const urls = {};

  await Promise.all(uniqueKeys.map(async (key) => {
    try {
      urls[key] = await getSignedReadUrl(key, { force });
    } catch (error) {
      console.error("Signed image URL could not be created:", error.message);
    }
  }));

  return urls;
}

async function uploadImageBuffer({ folder, buffer, mimeType, replaceUrl }) {
  const { bucket } = requireS3Config();
  const key = replacementKey({ folder, mimeType, replaceUrl });

  await getClient().send(new PutObjectCommand({
    Bucket: bucket,
    Key: key,
    Body: buffer,
    ContentType: mimeType,
    CacheControl: "private, max-age=3600",
  }));

  invalidateSignedUrl(key);
  const signed = await getSignedReadUrl(key, { force: true });

  return {
    key,
    url: canonicalUrlFor(key),
    signedUrl: signed.url,
    expiresAt: signed.expiresAt,
  };
}

async function deleteOwnedObject(value) {
  const key = normalizeObjectKey(value);
  if (!key) return;

  const { bucket } = readS3Config();
  if (!bucket || !process.env.AWS_ACCESS_KEY_ID) return;

  invalidateSignedUrl(key);

  try {
    await getClient().send(new DeleteObjectCommand({
      Bucket: bucket,
      Key: key,
    }));
  } catch (error) {
    console.error("S3 object could not be deleted:", error.message);
  }
}

module.exports = {
  ALLOWED_TYPES,
  deleteOwnedObject,
  normalizeObjectKey,
  resolveSignedMedia,
  signObjectKeys,
  storedMediaValue,
  uploadImageBuffer,
};

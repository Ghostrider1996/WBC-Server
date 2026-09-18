const { Router } = require("express");
const multer = require("multer");
const {
  listNewsPosts,
  getNewsPostByRef,
  createNewsPost,
  updateNewsPost,
  deleteNewsPost,
  listGalleryPosts,
  getGalleryPostByRef,
  createGalleryPost,
  updateGalleryPost,
  deleteGalleryPost,
} = require("../services/contentService");
const { isAdmin } = require("../services/adminService");
const { findUserByDiscordId } = require("../services/userService");
const { ALLOWED_TYPES, signObjectKeys, uploadImageBuffer } = require("../services/s3Service");

const contentRouter = Router();
const POST_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const imageUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_IMAGE_BYTES },
  fileFilter(_req, file, callback) {
    if (ALLOWED_TYPES[file.mimetype]) {
      callback(null, true);
      return;
    }

    callback(Object.assign(new Error("Only JPEG, PNG, WebP, GIF, or AVIF images are allowed."), { statusCode: 400 }));
  },
});

function requireAdmin(req, res) {
  if (isAdmin({
    username: req.body?.username,
    globalName: req.body?.globalName,
    discordId: req.body?.discordId,
  })) {
    return true;
  }

  res.status(403).json({ reason: "Only the guild admin can manage posts.", status: "failed" });
  return false;
}

function readPostId(req, res) {
  const id = typeof req.params.id === "string" ? req.params.id.trim() : "";
  if (!POST_ID_PATTERN.test(id)) {
    res.status(400).json({ reason: "A valid post id is required.", status: "failed" });
    return "";
  }
  return id;
}

function decodeParam(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function readPostRef(req, res) {
  const value = typeof req.params.id === "string" ? decodeParam(req.params.id).trim() : "";
  if (!value) {
    res.status(400).json({ reason: "A valid post is required.", status: "failed" });
    return "";
  }
  return value;
}

function readNewsFields(req) {
  const title = typeof req.body?.title === "string" ? req.body.title.trim() : "";
  const tag = typeof req.body?.tag === "string" ? req.body.tag.trim() : "";

  if (!title || !tag) {
    return { error: "Title and tag are required." };
  }

  return {
    title,
    tag,
    body: typeof req.body.body === "string" ? req.body.body.trim() : "",
    details: typeof req.body.details === "string" ? req.body.details.trim() : "",
    image: typeof req.body.image === "string" ? req.body.image.trim() : "",
    publishedAt: typeof req.body.publishedAt === "string" ? req.body.publishedAt.trim() : "",
    date: typeof req.body.date === "string" ? req.body.date.trim() : "",
  };
}

function readGalleryFields(req) {
  const url = typeof req.body?.url === "string" ? req.body.url.trim() : "";
  const title = typeof req.body?.title === "string" ? req.body.title.trim() : "";
  const mediaType = req.body?.mediaType || req.body?.type;

  if (!["image", "video"].includes(mediaType) || !title || !url) {
    return { error: "Media type, title, and URL are required." };
  }

  return {
    mediaType,
    title,
    url,
    details: mediaType === "image" && typeof req.body?.details === "string" ? req.body.details.trim() : "",
  };
}

function handleContentError(res, error, fallback) {
  const statusCode = error.statusCode || (error.code === "22P02" ? 400 : 500);
  if (statusCode >= 500) {
    console.error(fallback, error.message);
  }
  return res.status(statusCode).json({
    reason: statusCode >= 500 ? fallback : error.message,
    status: "failed",
  });
}

async function resolveCreatedBy(req) {
  const discordId = String(req.body?.discordId || "").trim();
  if (!discordId) return null;
  const user = await findUserByDiscordId(discordId);
  return user?.id || null;
}

function handleImageUpload(req, res, next) {
  imageUpload.single("file")(req, res, (error) => {
    if (!error) {
      next();
      return;
    }

    const reason = error.code === "LIMIT_FILE_SIZE"
      ? "Image must be 8MB or smaller."
      : error.message;
    return res.status(error.statusCode || 400).json({ reason, status: "failed" });
  });
}

contentRouter.post("/uploads/image", handleImageUpload, async (req, res) => {
  if (!requireAdmin(req, res)) {
    return;
  }

  if (!req.file?.buffer) {
    return res.status(400).json({ reason: "An image file is required.", status: "failed" });
  }

  const folder = req.body?.folder === "gallery" ? "gallery" : "news";

  try {
    const uploaded = await uploadImageBuffer({
      folder,
      buffer: req.file.buffer,
      mimeType: req.file.mimetype,
      replaceUrl: req.body?.replaceUrl || req.body?.replaceKey || "",
    });
    return res.status(201).json(uploaded);
  } catch (error) {
    return handleContentError(res, error, "The image could not be uploaded.");
  }
});

contentRouter.post("/uploads/sign", async (req, res) => {
  try {
    const urls = await signObjectKeys(req.body?.keys, { force: Boolean(req.body?.force) });
    return res.status(200).json({ urls });
  } catch (error) {
    return handleContentError(res, error, "Signed image URLs could not be created.");
  }
});

contentRouter.get("/news", async (req, res) => {
  try {
    const limit = Number.parseInt(req.query.limit, 10);
    const posts = await listNewsPosts(Number.isInteger(limit) && limit > 0 ? limit : undefined);
    return res.status(200).json(posts);
  } catch (error) {
    return handleContentError(res, error, "News posts could not be loaded.");
  }
});

contentRouter.get("/news/:id", async (req, res) => {
  const ref = readPostRef(req, res);
  if (!ref) return;

  try {
    const post = await getNewsPostByRef(ref, { signed: true });
    if (!post) {
      return res.status(404).json({ reason: "News post was not found.", status: "failed" });
    }
    return res.status(200).json(post);
  } catch (error) {
    return handleContentError(res, error, "The news post could not be loaded.");
  }
});

contentRouter.post("/news", async (req, res) => {
  if (!requireAdmin(req, res)) {
    return;
  }

  const fields = readNewsFields(req);
  if (fields.error) {
    return res.status(400).json({ reason: fields.error, status: "failed" });
  }

  try {
    const post = await createNewsPost({
      ...fields,
      createdBy: await resolveCreatedBy(req),
    });
    return res.status(201).json(post);
  } catch (error) {
    return handleContentError(res, error, "The news post could not be created.");
  }
});

contentRouter.patch("/news/:id", async (req, res) => {
  if (!requireAdmin(req, res)) {
    return;
  }

  const id = readPostId(req, res);
  if (!id) {
    return;
  }

  const fields = readNewsFields(req);
  if (fields.error) {
    return res.status(400).json({ reason: fields.error, status: "failed" });
  }

  try {
    const post = await updateNewsPost(id, fields);
    return res.status(200).json(post);
  } catch (error) {
    return handleContentError(res, error, "The news post could not be updated.");
  }
});

contentRouter.delete("/news/:id", async (req, res) => {
  if (!requireAdmin(req, res)) {
    return;
  }

  const id = readPostId(req, res);
  if (!id) {
    return;
  }

  try {
    await deleteNewsPost(id);
    return res.status(200).json({ status: "deleted" });
  } catch (error) {
    return handleContentError(res, error, "The news post could not be deleted.");
  }
});

contentRouter.get("/gallery", async (_req, res) => {
  try {
    const posts = await listGalleryPosts();
    return res.status(200).json(posts);
  } catch (error) {
    return handleContentError(res, error, "Gallery posts could not be loaded.");
  }
});

contentRouter.get("/gallery/:id", async (req, res) => {
  const ref = readPostRef(req, res);
  if (!ref) return;

  try {
    const post = await getGalleryPostByRef(ref, { signed: true });
    if (!post) {
      return res.status(404).json({ reason: "Gallery post was not found.", status: "failed" });
    }
    return res.status(200).json(post);
  } catch (error) {
    return handleContentError(res, error, "The gallery post could not be loaded.");
  }
});

contentRouter.post("/gallery", async (req, res) => {
  if (!requireAdmin(req, res)) {
    return;
  }

  const fields = readGalleryFields(req);
  if (fields.error) {
    return res.status(400).json({ reason: fields.error, status: "failed" });
  }

  try {
    const post = await createGalleryPost(fields);
    return res.status(201).json(post);
  } catch (error) {
    return handleContentError(res, error, "The gallery post could not be created.");
  }
});

contentRouter.patch("/gallery/:id", async (req, res) => {
  if (!requireAdmin(req, res)) {
    return;
  }

  const id = readPostId(req, res);
  if (!id) {
    return;
  }

  const fields = readGalleryFields(req);
  if (fields.error) {
    return res.status(400).json({ reason: fields.error, status: "failed" });
  }

  try {
    const post = await updateGalleryPost(id, fields);
    return res.status(200).json(post);
  } catch (error) {
    return handleContentError(res, error, "The gallery post could not be updated.");
  }
});

contentRouter.delete("/gallery/:id", async (req, res) => {
  if (!requireAdmin(req, res)) {
    return;
  }

  const id = readPostId(req, res);
  if (!id) {
    return;
  }

  try {
    await deleteGalleryPost(id);
    return res.status(200).json({ status: "deleted" });
  } catch (error) {
    return handleContentError(res, error, "The gallery post could not be deleted.");
  }
});

module.exports = contentRouter;

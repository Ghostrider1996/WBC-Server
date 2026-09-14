const { Router } = require("express");
const {
  listNewsPosts,
  createNewsPost,
  updateNewsPost,
  deleteNewsPost,
  listGalleryPosts,
  createGalleryPost,
  updateGalleryPost,
  deleteGalleryPost,
} = require("../services/contentService");
const { isAdmin } = require("../services/adminService");
const { findUserByDiscordId } = require("../services/userService");

const contentRouter = Router();
const POST_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

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

  return { mediaType, title, url };
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

contentRouter.get("/news", async (req, res) => {
  try {
    const limit = Number.parseInt(req.query.limit, 10);
    const posts = await listNewsPosts(Number.isInteger(limit) && limit > 0 ? limit : undefined);
    return res.status(200).json(posts);
  } catch (error) {
    return handleContentError(res, error, "News posts could not be loaded.");
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

const { Router } = require("express");
const {
  listNewsPosts,
  createNewsPost,
  listGalleryPosts,
  createGalleryPost,
} = require("../services/contentService");

const contentRouter = Router();

function isAdmin(username) {
  const adminUsername = process.env.ADMIN_USERNAME;

  if (!adminUsername || !username || typeof username !== "string") {
    return false;
  }

  return username.trim().toLowerCase() === adminUsername.trim().toLowerCase();
}

function requireAdmin(req, res) {
  if (isAdmin(req.body?.username)) {
    return true;
  }

  res.status(403).json({ reason: "Only the guild admin can create posts.", status: "failed" });
  return false;
}

contentRouter.get("/news", async (req, res) => {
  try {
    const limit = Number.parseInt(req.query.limit, 10);
    const posts = await listNewsPosts(Number.isInteger(limit) && limit > 0 ? limit : undefined);
    return res.status(200).json(posts);
  } catch (error) {
    console.error("List news posts failed:", error.message);
    return res.status(500).json({ reason: "News posts could not be loaded.", status: "failed" });
  }
});

contentRouter.post("/news", async (req, res) => {
  if (!requireAdmin(req, res)) {
    return;
  }

  const title = typeof req.body?.title === "string" ? req.body.title.trim() : "";
  const tag = typeof req.body?.tag === "string" ? req.body.tag.trim() : "";

  if (!title || !tag) {
    return res.status(400).json({ reason: "Title and tag are required.", status: "failed" });
  }

  try {
    const post = await createNewsPost({
      title,
      tag,
      body: typeof req.body.body === "string" ? req.body.body.trim() : "",
      image: typeof req.body.image === "string" ? req.body.image.trim() : "",
      publishedAt: typeof req.body.publishedAt === "string" ? req.body.publishedAt.trim() : "",
      date: typeof req.body.date === "string" ? req.body.date.trim() : "",
    });
    return res.status(201).json(post);
  } catch (error) {
    console.error("Create news post failed:", error.message);
    return res.status(500).json({ reason: "The news post could not be created.", status: "failed" });
  }
});

contentRouter.get("/gallery", async (_req, res) => {
  try {
    const posts = await listGalleryPosts();
    return res.status(200).json(posts);
  } catch (error) {
    console.error("List gallery posts failed:", error.message);
    return res.status(500).json({ reason: "Gallery posts could not be loaded.", status: "failed" });
  }
});

contentRouter.post("/gallery", async (req, res) => {
  if (!requireAdmin(req, res)) {
    return;
  }

  const url = typeof req.body?.url === "string" ? req.body.url.trim() : "";
  const title = typeof req.body?.title === "string" ? req.body.title.trim() : "";
  const mediaType = req.body?.mediaType || req.body?.type;

  if (!["image", "video"].includes(mediaType) || !title || !url) {
    return res.status(400).json({ reason: "Media type, title, and URL are required.", status: "failed" });
  }

  try {
    const post = await createGalleryPost({
      mediaType,
      title,
      url,
    });
    return res.status(201).json(post);
  } catch (error) {
    console.error("Create gallery post failed:", error.message);
    return res.status(500).json({ reason: "The gallery post could not be created.", status: "failed" });
  }
});

module.exports = contentRouter;

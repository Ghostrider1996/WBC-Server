const { query } = require("../db/pool");
const { deleteOwnedObject, normalizeObjectKey, resolveSignedMedia, storedMediaValue } = require("./s3Service");

function formatDisplayDate(value) {
  return new Date(value).toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function parsePublishedAt(dateText) {
  if (!dateText || typeof dateText !== "string") {
    return new Date();
  }

  const parsed = new Date(dateText.trim());
  if (!Number.isNaN(parsed.getTime())) {
    return parsed;
  }

  const withYear = new Date(`${dateText.trim()} ${new Date().getFullYear()}`);
  return Number.isNaN(withYear.getTime()) ? new Date() : withYear;
}

function mapNewsPost(row) {
  return {
    id: row.id,
    title: row.title,
    tag: row.tag,
    body: row.body || "",
    details: row.details || "",
    image: row.image_url || "",
    author: row.author_name || "",
    date: formatDisplayDate(row.published_at),
    publishedAt: row.published_at,
  };
}

async function presentNewsPost(post) {
  if (!post) return null;
  const media = await resolveSignedMedia(post.image);
  return {
    ...post,
    image: media.url,
    imageKey: media.key,
    imageExpiresAt: media.expiresAt,
  };
}

async function presentGalleryPost(post) {
  if (!post) return null;
  if (post.mediaType === "video" || post.type === "video") {
    return {
      ...post,
      objectKey: "",
      urlExpiresAt: null,
    };
  }

  const media = await resolveSignedMedia(post.url);
  return {
    ...post,
    url: media.url,
    objectKey: media.key,
    urlExpiresAt: media.expiresAt,
  };
}

const NEWS_SELECT = `
  SELECT
    news_posts.id,
    news_posts.title,
    news_posts.tag,
    news_posts.body,
    news_posts.details,
    news_posts.image_url,
    news_posts.published_at,
    COALESCE(NULLIF(users.global_name, ''), users.username) AS author_name
  FROM news_posts
  LEFT JOIN users ON users.id = news_posts.created_by
`;

async function getNewsPostById(id, { signed = false } = {}) {
  const result = await query(`${NEWS_SELECT} WHERE news_posts.id = $1`, [id]);
  const post = result.rows[0] ? mapNewsPost(result.rows[0]) : null;
  return signed ? presentNewsPost(post) : post;
}

async function listNewsPosts(limit) {
  const values = [];
  let sql = `
    ${NEWS_SELECT}
    ORDER BY news_posts.published_at DESC, news_posts.created_at DESC
  `;

  if (limit) {
    values.push(limit);
    sql += ` LIMIT $1`;
  }

  const result = await query(sql, values);
  return Promise.all(result.rows.map((row) => presentNewsPost(mapNewsPost(row))));
}

async function createNewsPost({ title, tag, image, body, details, publishedAt, date, createdBy }) {
  const result = await query(
    `
      INSERT INTO news_posts (title, tag, image_url, body, details, published_at, created_by)
      VALUES ($1, $2, $3, $4, $5, $6, $7)
      RETURNING id
    `,
    [
      title,
      tag,
      storedMediaValue(image),
      body || null,
      details || null,
      parsePublishedAt(publishedAt || date),
      createdBy || null,
    ],
  );

  return getNewsPostById(result.rows[0].id, { signed: true });
}

function mapGalleryPost(row) {
  return {
    id: row.id,
    type: row.media_type,
    mediaType: row.media_type,
    title: row.title,
    url: row.url,
    details: row.media_type === "image" ? (row.details || "") : "",
    createdAt: row.created_at,
  };
}

const GALLERY_SELECT = `
  SELECT id, media_type, title, url, details, created_at
  FROM gallery_posts
`;

async function getGalleryPostById(id, { signed = false } = {}) {
  const result = await query(`${GALLERY_SELECT} WHERE id = $1`, [id]);
  const post = result.rows[0] ? mapGalleryPost(result.rows[0]) : null;
  return signed ? presentGalleryPost(post) : post;
}

async function listGalleryPosts() {
  const result = await query(`
    ${GALLERY_SELECT}
    ORDER BY created_at DESC
  `);

  return Promise.all(result.rows.map((row) => presentGalleryPost(mapGalleryPost(row))));
}

async function createGalleryPost({ mediaType, type, title, url, details }) {
  const resolvedType = mediaType || type;

  if (!["image", "video"].includes(resolvedType)) {
    throw Object.assign(new Error("Gallery media type must be image or video."), { statusCode: 400 });
  }

  const storedUrl = resolvedType === "image" ? storedMediaValue(url) : (url || null);

  const result = await query(
    `
      INSERT INTO gallery_posts (media_type, title, url, details)
      VALUES ($1, $2, $3, $4)
      RETURNING id, media_type, title, url, details, created_at
    `,
    [resolvedType, title, storedUrl, resolvedType === "image" ? details || null : null],
  );

  return presentGalleryPost(mapGalleryPost(result.rows[0]));
}

function missingPostError(kind) {
  return Object.assign(new Error(`${kind} post was not found.`), { statusCode: 404 });
}

async function updateNewsPost(id, { title, tag, image, body, details, publishedAt, date }) {
  const previous = await getNewsPostById(id);
  if (!previous) {
    throw missingPostError("News");
  }

  const result = await query(
    `
      UPDATE news_posts
      SET title = $2,
          tag = $3,
          image_url = $4,
          body = $5,
          details = $6,
          published_at = $7
      WHERE id = $1
      RETURNING id
    `,
    [
      id,
      title,
      tag,
      storedMediaValue(image),
      body || null,
      details || null,
      parsePublishedAt(publishedAt || date),
    ],
  );

  if (!result.rows[0]) {
    throw missingPostError("News");
  }

  const updated = await getNewsPostById(result.rows[0].id);
  const previousKey = normalizeObjectKey(previous.image);
  const nextKey = normalizeObjectKey(updated.image);
  if (previousKey && previousKey !== nextKey) {
    await deleteOwnedObject(previous.image);
  }
  return presentNewsPost(updated);
}

async function deleteNewsPost(id) {
  const previous = await getNewsPostById(id);
  if (!previous) {
    throw missingPostError("News");
  }

  const result = await query(
    `
      DELETE FROM news_posts
      WHERE id = $1
      RETURNING id
    `,
    [id],
  );

  if (!result.rows[0]) {
    throw missingPostError("News");
  }

  if (previous.image) {
    await deleteOwnedObject(previous.image);
  }
}

async function updateGalleryPost(id, { mediaType, type, title, url, details }) {
  const previous = await getGalleryPostById(id);
  if (!previous) {
    throw missingPostError("Gallery");
  }

  const resolvedType = mediaType || type;

  if (!["image", "video"].includes(resolvedType)) {
    throw Object.assign(new Error("Gallery media type must be image or video."), { statusCode: 400 });
  }

  const storedUrl = resolvedType === "image" ? storedMediaValue(url) : (url || null);

  const result = await query(
    `
      UPDATE gallery_posts
      SET media_type = $2,
          title = $3,
          url = $4,
          details = $5
      WHERE id = $1
      RETURNING id, media_type, title, url, details, created_at
    `,
    [id, resolvedType, title, storedUrl, resolvedType === "image" ? details || null : null],
  );

  if (!result.rows[0]) {
    throw missingPostError("Gallery");
  }

  const updated = mapGalleryPost(result.rows[0]);
  const previousKey = normalizeObjectKey(previous.url);
  const nextKey = resolvedType === "image" ? normalizeObjectKey(updated.url) : "";
  if (previousKey && previousKey !== nextKey) {
    await deleteOwnedObject(previous.url);
  }
  return presentGalleryPost(updated);
}

async function deleteGalleryPost(id) {
  const previous = await getGalleryPostById(id);
  if (!previous) {
    throw missingPostError("Gallery");
  }

  const result = await query(
    `
      DELETE FROM gallery_posts
      WHERE id = $1
      RETURNING id
    `,
    [id],
  );

  if (!result.rows[0]) {
    throw missingPostError("Gallery");
  }

  if (previous.url) {
    await deleteOwnedObject(previous.url);
  }
}

module.exports = {
  listNewsPosts,
  getNewsPostById,
  createNewsPost,
  updateNewsPost,
  deleteNewsPost,
  listGalleryPosts,
  getGalleryPostById,
  createGalleryPost,
  updateGalleryPost,
  deleteGalleryPost,
};

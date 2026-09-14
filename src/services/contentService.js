const { query } = require("../db/pool");

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
    image: row.image_url,
    author: row.author_name || "",
    date: formatDisplayDate(row.published_at),
    publishedAt: row.published_at,
  };
}

const NEWS_SELECT = `
  SELECT
    news_posts.id,
    news_posts.title,
    news_posts.tag,
    news_posts.body,
    news_posts.image_url,
    news_posts.published_at,
    COALESCE(NULLIF(users.global_name, ''), users.username) AS author_name
  FROM news_posts
  LEFT JOIN users ON users.id = news_posts.created_by
`;

async function getNewsPostById(id) {
  const result = await query(`${NEWS_SELECT} WHERE news_posts.id = $1`, [id]);
  return result.rows[0] ? mapNewsPost(result.rows[0]) : null;
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
  return result.rows.map(mapNewsPost);
}

async function createNewsPost({ title, tag, image, body, publishedAt, date, createdBy }) {
  const result = await query(
    `
      INSERT INTO news_posts (title, tag, image_url, body, published_at, created_by)
      VALUES ($1, $2, $3, $4, $5, $6)
      RETURNING id
    `,
    [
      title,
      tag,
      image || null,
      body || null,
      parsePublishedAt(publishedAt || date),
      createdBy || null,
    ],
  );

  return getNewsPostById(result.rows[0].id);
}

function mapGalleryPost(row) {
  return {
    id: row.id,
    type: row.media_type,
    mediaType: row.media_type,
    title: row.title,
    url: row.url,
    createdAt: row.created_at,
  };
}

async function listGalleryPosts() {
  const result = await query(`
    SELECT id, media_type, title, url, created_at
    FROM gallery_posts
    ORDER BY created_at DESC
  `);

  return result.rows.map(mapGalleryPost);
}

async function createGalleryPost({ mediaType, type, title, url }) {
  const resolvedType = mediaType || type;

  if (!["image", "video"].includes(resolvedType)) {
    throw Object.assign(new Error("Gallery media type must be image or video."), { statusCode: 400 });
  }

  const result = await query(
    `
      INSERT INTO gallery_posts (media_type, title, url)
      VALUES ($1, $2, $3)
      RETURNING id, media_type, title, url, created_at
    `,
    [resolvedType, title, url],
  );

  return mapGalleryPost(result.rows[0]);
}

function missingPostError(kind) {
  return Object.assign(new Error(`${kind} post was not found.`), { statusCode: 404 });
}

async function updateNewsPost(id, { title, tag, image, body, publishedAt, date }) {
  const result = await query(
    `
      UPDATE news_posts
      SET title = $2,
          tag = $3,
          image_url = $4,
          body = $5,
          published_at = $6
      WHERE id = $1
      RETURNING id
    `,
    [
      id,
      title,
      tag,
      image || null,
      body || null,
      parsePublishedAt(publishedAt || date),
    ],
  );

  if (!result.rows[0]) {
    throw missingPostError("News");
  }

  return getNewsPostById(result.rows[0].id);
}

async function deleteNewsPost(id) {
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
}

async function updateGalleryPost(id, { mediaType, type, title, url }) {
  const resolvedType = mediaType || type;

  if (!["image", "video"].includes(resolvedType)) {
    throw Object.assign(new Error("Gallery media type must be image or video."), { statusCode: 400 });
  }

  const result = await query(
    `
      UPDATE gallery_posts
      SET media_type = $2,
          title = $3,
          url = $4
      WHERE id = $1
      RETURNING id, media_type, title, url, created_at
    `,
    [id, resolvedType, title, url],
  );

  if (!result.rows[0]) {
    throw missingPostError("Gallery");
  }

  return mapGalleryPost(result.rows[0]);
}

async function deleteGalleryPost(id) {
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
}

module.exports = {
  listNewsPosts,
  createNewsPost,
  updateNewsPost,
  deleteNewsPost,
  listGalleryPosts,
  createGalleryPost,
  updateGalleryPost,
  deleteGalleryPost,
};

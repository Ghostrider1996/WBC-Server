const { query } = require("../db/pool");

function formatDisplayDate(value) {
  return new Date(value).toLocaleDateString("en-US", {
    month: "short",
    day: "2-digit",
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
    date: formatDisplayDate(row.published_at),
    publishedAt: row.published_at,
  };
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

async function listNewsPosts(limit) {
  const values = [];
  let sql = `
    SELECT id, title, tag, body, image_url, published_at
    FROM news_posts
    ORDER BY published_at DESC, created_at DESC
  `;

  if (limit) {
    values.push(limit);
    sql += ` LIMIT $1`;
  }

  const result = await query(sql, values);
  return result.rows.map(mapNewsPost);
}

async function createNewsPost({ title, tag, image, body, publishedAt, date }) {
  const result = await query(
    `
      INSERT INTO news_posts (title, tag, image_url, body, published_at)
      VALUES ($1, $2, $3, $4, $5)
      RETURNING id, title, tag, body, image_url, published_at
    `,
    [
      title,
      tag,
      image || null,
      body || null,
      parsePublishedAt(publishedAt || date),
    ],
  );

  return mapNewsPost(result.rows[0]);
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

module.exports = {
  listNewsPosts,
  createNewsPost,
  listGalleryPosts,
  createGalleryPost,
};

const { query } = require("../db/pool");

const POST_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SLUG_TABLES = {
  news: "news_posts",
  gallery: "gallery_posts",
};

function isPostId(value) {
  return POST_ID_PATTERN.test(String(value || "").trim());
}

function slugifyTitle(title) {
  const slug = String(title || "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80)
    .replace(/-+$/g, "");

  return slug || "post";
}

async function allocateSlug(kind, title, excludeId) {
  const table = SLUG_TABLES[kind];
  const base = slugifyTitle(title);
  let slug = base;
  let suffix = 2;

  while (true) {
    const result = await query(
      `
        SELECT id
        FROM ${table}
        WHERE slug = $1
          AND ($2::uuid IS NULL OR id <> $2)
        LIMIT 1
      `,
      [slug, excludeId || null],
    );

    if (!result.rows[0]) return slug;
    slug = `${base.slice(0, 70)}-${suffix}`;
    suffix += 1;
  }
}

async function backfillTable(kind) {
  const table = SLUG_TABLES[kind];
  const result = await query(`SELECT id, title FROM ${table} WHERE slug IS NULL OR btrim(slug) = ''`);

  for (const row of result.rows) {
    const slug = await allocateSlug(kind, row.title, row.id);
    await query(`UPDATE ${table} SET slug = $2 WHERE id = $1`, [row.id, slug]);
  }
}

async function backfillPostSlugs() {
  await backfillTable("news");
  await backfillTable("gallery");
}

module.exports = {
  POST_ID_PATTERN,
  isPostId,
  slugifyTitle,
  allocateSlug,
  backfillPostSlugs,
};

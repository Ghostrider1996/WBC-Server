const fs = require("fs");
const path = require("path");
const { query } = require("./pool");
const { backfillPostSlugs } = require("../services/postSlug");

async function ensureSchema() {
  const schemaPath = path.resolve(__dirname, "schema.sql");
  const schemaSql = fs.readFileSync(schemaPath, "utf8");
  await query(schemaSql);
  await backfillPostSlugs();
}

module.exports = { ensureSchema };

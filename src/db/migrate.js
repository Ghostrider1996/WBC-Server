const fs = require("fs");
const path = require("path");
const dotenv = require("dotenv");
const { Client } = require("pg");
const { getSslConfig, normalizeDatabaseUrl } = require("./connection");

dotenv.config({ path: path.resolve(__dirname, "../../.env") });

function getMigrationUrl() {
  if (process.env.DATABASE_URL_DIRECT) {
    return normalizeDatabaseUrl(process.env.DATABASE_URL_DIRECT);
  }

  if (!process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL is missing");
  }

  return normalizeDatabaseUrl(process.env.DATABASE_URL.replace("-pooler", ""));
}

async function migrate() {
  const schemaPath = path.resolve(__dirname, "schema.sql");
  const schemaSql = fs.readFileSync(schemaPath, "utf8");
  const client = new Client({
    connectionString: getMigrationUrl(),
    ssl: getSslConfig(),
  });

  await client.connect();

  try {
    await client.query("BEGIN");
    await client.query(schemaSql);
    const seedSql = fs.readFileSync(path.resolve(__dirname, "seed.sql"), "utf8");
    await client.query(seedSql);
    await client.query("COMMIT");

    const tables = await client.query(`
      SELECT table_name
      FROM information_schema.tables
      WHERE table_schema = 'public'
        AND table_type = 'BASE TABLE'
      ORDER BY table_name
    `);

    console.log("Neon schema applied:");
    for (const row of tables.rows) {
      console.log(`- ${row.table_name}`);
    }
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    await client.end();
  }
}

migrate().catch((error) => {
  console.error("Database migration failed:", error.message);
  process.exit(1);
});

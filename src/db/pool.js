const { Pool } = require("pg");

let pool;

function normalizeDatabaseUrl(connectionString) {
  const trimmed = String(connectionString).trim().replace(/^['"]|['"]$/g, "");
  const url = new URL(trimmed);

  if (process.env.RENDER === "true") {
    url.searchParams.delete("channel_binding");
  }

  if (!url.searchParams.get("sslmode")) {
    url.searchParams.set("sslmode", "require");
  }

  return url.toString();
}

function getPoolConfig() {
  const connectionString = process.env.DATABASE_URL;

  if (!connectionString) {
    throw new Error("DATABASE_URL is missing");
  }

  const onRender = process.env.RENDER === "true";

  return {
    connectionString: normalizeDatabaseUrl(connectionString),
    max: 10,
    ssl: {
      require: true,
      rejectUnauthorized: !onRender,
    },
  };
}

function getPool() {
  if (pool) {
    return pool;
  }

  pool = new Pool(getPoolConfig());

  return pool;
}

function query(text, params) {
  return getPool().query(text, params);
}

async function closePool() {
  if (!pool) {
    return;
  }

  await pool.end();
  pool = null;
}

module.exports = { getPool, query, closePool };

const { Pool } = require("pg");

let pool;

function getPool() {
  if (pool) {
    return pool;
  }

  const connectionString = process.env.DATABASE_URL;

  if (!connectionString) {
    throw new Error("DATABASE_URL is missing");
  }

  pool = new Pool({
    connectionString,
    max: 10,
    ssl: {
      rejectUnauthorized: true,
    },
  });

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

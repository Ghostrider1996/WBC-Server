const { Pool } = require("pg");
const { getSslConfig, normalizeDatabaseUrl } = require("./connection");

let pool;

function getPoolConfig() {
  const connectionString = process.env.DATABASE_URL;

  if (!connectionString) {
    throw new Error("DATABASE_URL is missing");
  }

  return {
    connectionString: normalizeDatabaseUrl(connectionString),
    max: 10,
    ssl: getSslConfig(),
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

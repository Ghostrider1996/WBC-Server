function normalizeDatabaseUrl(connectionString) {
  const trimmed = String(connectionString).trim().replace(/^['"]|['"]$/g, "");
  const url = new URL(trimmed);

  if (process.env.RENDER === "true") {
    url.searchParams.delete("channel_binding");
  }

  const sslMode = url.searchParams.get("sslmode");
  if (!sslMode || sslMode === "require" || sslMode === "prefer" || sslMode === "verify-ca") {
    url.searchParams.set("sslmode", "verify-full");
  }

  return url.toString();
}

function getSslConfig() {
  return {
    require: true,
    rejectUnauthorized: process.env.RENDER !== "true",
  };
}

module.exports = { normalizeDatabaseUrl, getSslConfig };

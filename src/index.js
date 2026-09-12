const dotenv = require("dotenv");
const express = require("express");
const path = require('path');
const { configRoutes } = require("./config/configRouter");
const { configExpress } = require("./config/configExpress");
const { query } = require("./db/pool");
const { ensureSchema } = require("./db/ensureSchema");

dotenv.config({ path: path.resolve(__dirname, "../.env") });

const PORT = process.env.PORT || 3030;
const app = express();

configExpress(app);

app.get("/api/health", async (_req, res) => {
  try {
    await query("SELECT 1");
    return res.status(200).json({ ok: true, database: "connected" });
  } catch (error) {
    return res.status(503).json({
      ok: false,
      database: "disconnected",
      reason: error.message,
    });
  }
});

configRoutes(app);

app.listen(PORT, async () => {
  console.log(`Guild backend running on http://localhost:${PORT}`);

  try {
    await query("SELECT 1");
    await ensureSchema();
    console.log("Neon database connected");
  } catch (error) {
    console.error("Neon database connection failed:", error.message);
  }
});

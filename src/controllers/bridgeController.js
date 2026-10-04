const { Router } = require("express");
const { authorizeBridge, ingestBridgeUpload, listGuildRoster } = require("../services/bridgeService");

const bridgeRouter = Router();

function handleBridgeError(res, error, fallback) {
  const statusCode = error.statusCode || 500;
  if (statusCode >= 500) {
    console.error(fallback, error.message);
  }

  return res.status(statusCode).json({
    reason: statusCode >= 500 ? fallback : error.message,
    status: "failed",
  });
}

bridgeRouter.post("/bridge/upload", async (req, res) => {
  try {
    authorizeBridge(req);
    await ingestBridgeUpload(req.body || {});
    return res.status(204).end();
  } catch (error) {
    return handleBridgeError(res, error, "Bridge upload could not be saved.");
  }
});

bridgeRouter.get("/roster", async (_req, res) => {
  try {
    const roster = await listGuildRoster();
    return res.status(200).json(roster);
  } catch (error) {
    return handleBridgeError(res, error, "Guild roster could not be loaded.");
  }
});

module.exports = bridgeRouter; // guild roster + bridge upload


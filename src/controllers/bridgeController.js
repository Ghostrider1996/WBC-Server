const { Router } = require("express");
const { isAdmin } = require("../services/adminService");
const { authorizeBridge, ingestBridgeUpload, listGuildRoster, updateGuildMessage } = require("../services/bridgeService");

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

bridgeRouter.patch("/roster/message", async (req, res) => {
  try {
    const allowed = await isAdmin({
      username: req.body?.username,
      globalName: req.body?.globalName,
      discordId: req.body?.discordId,
    });
    if (!allowed) {
      return res.status(403).json({ reason: "Only a guild admin can update the message of the day.", status: "failed" });
    }
    if (typeof req.body?.messageOfTheDay !== "string") {
      return res.status(400).json({ reason: "A message is required.", status: "failed" });
    }

    const messageOfTheDay = await updateGuildMessage(req.body.messageOfTheDay);
    return res.status(200).json({ messageOfTheDay });
  } catch (error) {
    return handleBridgeError(res, error, "The guild message could not be saved.");
  }
});

module.exports = bridgeRouter; // guild roster + bridge upload


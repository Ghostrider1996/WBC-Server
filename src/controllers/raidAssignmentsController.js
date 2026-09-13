const { Router } = require("express");
const { isAdmin } = require("../services/adminService");
const { pushRaidAssignments } = require("../services/discordWebhookService");

const raidAssignmentsRouter = Router();

raidAssignmentsRouter.post("/raid-assignments/discord", async (req, res) => {
  if (!isAdmin({
    username: req.body?.username,
    globalName: req.body?.globalName,
    discordId: req.body?.discordId,
  })) {
    return res.status(403).json({ reason: "Only the guild admin can push assignments.", status: "failed" });
  }

  const title = typeof req.body?.title === "string" ? req.body.title.trim() : "";
  const sections = req.body?.sections;
  const eventId = typeof req.body?.eventId === "string" ? req.body.eventId.trim() : "";

  if (!title || !Array.isArray(sections) || sections.length === 0) {
    return res.status(400).json({ reason: "Assignment title and sections are required.", status: "failed" });
  }

  try {
    await pushRaidAssignments({
      title,
      sections,
      includeImage: req.body?.includeImage !== false,
      eventId,
    });
    return res.status(201).json({ status: "pushed" });
  } catch (error) {
    const statusCode = error.statusCode || 500;
    console.error("Raid assignment Discord push failed:", statusCode, error.message);
    return res.status(statusCode).json({
      reason: error.message,
      status: "failed",
    });
  }
});

module.exports = raidAssignmentsRouter;

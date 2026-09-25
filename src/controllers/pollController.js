const { Router } = require("express");
const { isAdmin } = require("../services/adminService");
const { findUserByDiscordId } = require("../services/userService");
const { createPoll, listPolls } = require("../services/pollService");

const pollRouter = Router();

function requireAdmin(req, res) {
  if (isAdmin({
    username: req.body?.username,
    globalName: req.body?.globalName,
    discordId: req.body?.discordId,
  })) {
    return true;
  }

  res.status(403).json({ reason: "Only the guild admin can create polls.", status: "failed" });
  return false;
}

function handlePollError(res, error, fallback) {
  const statusCode = error.statusCode || 500;
  if (statusCode >= 500) {
    console.error(fallback, error.message);
  }

  return res.status(statusCode).json({
    reason: statusCode >= 500 ? fallback : error.message,
    status: "failed",
  });
}

async function resolveCreatedBy(req) {
  const discordId = String(req.body?.discordId || "").trim();
  if (!discordId) return null;
  const user = await findUserByDiscordId(discordId);
  return user?.id || null;
}

pollRouter.get("/polls", async (_req, res) => {
  try {
    const polls = await listPolls();
    return res.status(200).json(polls);
  } catch (error) {
    return handlePollError(res, error, "Polls could not be loaded.");
  }
});

pollRouter.post("/polls", async (req, res) => {
  if (!requireAdmin(req, res)) {
    return;
  }

  try {
    const poll = await createPoll({
      question: req.body?.question,
      options: req.body?.options,
      createdBy: await resolveCreatedBy(req),
    });
    return res.status(201).json(poll);
  } catch (error) {
    return handlePollError(res, error, "The poll could not be created.");
  }
});

module.exports = pollRouter;

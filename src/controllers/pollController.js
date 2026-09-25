const { Router } = require("express");
const { isAdmin } = require("../services/adminService");
const { findUserByDiscordId } = require("../services/userService");
const { createPoll, getPollVoters, listPolls, removePollVotes, voteOnPoll } = require("../services/pollService");

const pollRouter = Router();
const POLL_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

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

async function resolveUser(req, res, { required = false } = {}) {
  const discordId = String(req.body?.discordId || req.query.discordId || "").trim();
  if (!discordId) {
    if (!required) return null;
    res.status(400).json({ reason: "A Discord account is required.", status: "failed" });
    return undefined;
  }

  const user = await findUserByDiscordId(discordId);
  if (!user) {
    if (!required) return null;
    res.status(401).json({ reason: "Sign in with Discord to vote.", status: "failed" });
    return undefined;
  }

  return user;
}

function readPollId(req, res) {
  const id = typeof req.params.id === "string" ? req.params.id.trim() : "";
  if (!POLL_ID_PATTERN.test(id)) {
    res.status(400).json({ reason: "A valid poll is required.", status: "failed" });
    return "";
  }
  return id;
}

pollRouter.get("/polls", async (req, res) => {
  try {
    const user = await resolveUser(req, res);
    if (user === undefined) return;
    const polls = await listPolls(user?.id || null);
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
    const user = await resolveUser(req, res);
    if (user === undefined) return;
    const poll = await createPoll({
      question: req.body?.question,
      options: req.body?.options,
      allowMultiple: req.body?.allowMultiple,
      createdBy: user?.id || null,
    });
    return res.status(201).json(poll);
  } catch (error) {
    return handlePollError(res, error, "The poll could not be created.");
  }
});

pollRouter.get("/polls/:id/voters", async (req, res) => {
  try {
    const pollId = readPollId(req, res);
    if (!pollId) return;

    const user = await resolveUser(req, res, { required: true });
    if (!user) return;

    const poll = await getPollVoters(pollId);
    return res.status(200).json(poll);
  } catch (error) {
    return handlePollError(res, error, "Poll votes could not be loaded.");
  }
});

pollRouter.post("/polls/:id/votes", async (req, res) => {
  try {
    const pollId = readPollId(req, res);
    if (!pollId) return;

    const user = await resolveUser(req, res, { required: true });
    if (!user) return;

    const optionIds = Array.isArray(req.body?.optionIds)
      ? req.body.optionIds
      : [req.body?.optionId];

    const poll = await voteOnPoll({
      pollId,
      optionIds,
      userId: user.id,
      discordUserId: user.discord_id,
    });
    return res.status(201).json(poll);
  } catch (error) {
    return handlePollError(res, error, "Your vote could not be saved.");
  }
});

pollRouter.delete("/polls/:id/votes", async (req, res) => {
  try {
    const pollId = readPollId(req, res);
    if (!pollId) return;

    const user = await resolveUser(req, res, { required: true });
    if (!user) return;

    const poll = await removePollVotes({
      pollId,
      userId: user.id,
    });
    return res.status(200).json(poll);
  } catch (error) {
    return handlePollError(res, error, "Your vote could not be removed.");
  }
});

module.exports = pollRouter;

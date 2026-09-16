const { Router } = require("express");
const { isAdmin } = require("../services/adminService");
const { findUserByDiscordId } = require("../services/userService");
const { listRecruitment, updateRecruitmentStatuses } = require("../services/recruitmentService");

const recruitmentRouter = Router();

function requireAdmin(req, res) {
  if (isAdmin({
    username: req.body?.username,
    globalName: req.body?.globalName,
    discordId: req.body?.discordId,
  })) {
    return true;
  }

  res.status(403).json({ reason: "Only the guild admin can update recruitment.", status: "failed" });
  return false;
}

function handleRecruitmentError(res, error, fallback) {
  const statusCode = error.statusCode || 500;
  if (statusCode >= 500) {
    console.error(fallback, error.message);
  }

  return res.status(statusCode).json({
    reason: statusCode >= 500 ? fallback : error.message,
    status: "failed",
  });
}

async function resolveUpdatedBy(req) {
  const discordId = String(req.body?.discordId || "").trim();
  if (!discordId) return null;
  const user = await findUserByDiscordId(discordId);
  return user?.id || null;
}

recruitmentRouter.get("/recruitment", async (_req, res) => {
  try {
    const classes = await listRecruitment();
    return res.status(200).json(classes);
  } catch (error) {
    return handleRecruitmentError(res, error, "Recruitment could not be loaded.");
  }
});

recruitmentRouter.patch("/recruitment", async (req, res) => {
  if (!requireAdmin(req, res)) {
    return;
  }

  try {
    const classes = await updateRecruitmentStatuses(req.body?.statuses, await resolveUpdatedBy(req));
    return res.status(200).json(classes);
  } catch (error) {
    return handleRecruitmentError(res, error, "Recruitment statuses could not be saved.");
  }
});

module.exports = recruitmentRouter;

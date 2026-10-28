const { Router } = require("express");
const {
  addGuildAdmin,
  getAdminStatus,
  isAdmin,
  listGuildAdmins,
} = require("../services/adminService");
const { listApplicants, setApplicantMains } = require("../services/applicantService");

const adminRouter = Router();

function actorFromRequest(req) {
  return {
    username: req.body?.username || req.query.username,
    globalName: req.body?.globalName || req.query.globalName,
    discordId: req.body?.discordId || req.query.discordId,
  };
}

function handleAdminError(res, error, fallback) {
  const statusCode = error.statusCode || 500;
  if (statusCode >= 500) {
    console.error(fallback, error.message);
  }

  return res.status(statusCode).json({
    reason: statusCode >= 500 ? fallback : error.message,
    status: "failed",
  });
}

adminRouter.get("/admins", async (req, res) => {
  try {
    const actor = actorFromRequest(req);
    const status = await getAdminStatus(actor);
    const payload = { ...status };

    if (status.canManageAdmins) {
      payload.admins = await listGuildAdmins();
    }

    return res.status(200).json(payload);
  } catch (error) {
    return handleAdminError(res, error, "Admin status could not be loaded.");
  }
});

adminRouter.get("/applicants", async (req, res) => {
  try {
    const actor = actorFromRequest(req);
    if (!(await isAdmin(actor))) {
      return res.status(403).json({ reason: "Only a guild admin can view applicants.", status: "failed" });
    }

    return res.status(200).json({ applicants: await listApplicants() });
  } catch (error) {
    return handleAdminError(res, error, "Applicants could not be loaded.");
  }
});

adminRouter.post("/applicants/mains", async (req, res) => {
  try {
    const actor = actorFromRequest(req);
    if (!(await isAdmin(actor))) {
      return res.status(403).json({ reason: "Only a guild admin can set main characters.", status: "failed" });
    }

    return res.status(200).json({ applicants: await setApplicantMains(req.body?.applicants) });
  } catch (error) {
    return handleAdminError(res, error, "The main characters could not be saved.");
  }
});

adminRouter.post("/admins", async (req, res) => {
  try {
    const admins = await addGuildAdmin({
      actor: actorFromRequest(req),
      password: req.body?.password,
      adminDiscordId: req.body?.adminDiscordId,
    });

    return res.status(201).json({
      isAdmin: true,
      canManageAdmins: true,
      admins,
    });
  } catch (error) {
    return handleAdminError(res, error, "The admin could not be added.");
  }
});

module.exports = adminRouter;

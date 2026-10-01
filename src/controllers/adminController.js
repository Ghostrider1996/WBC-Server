const { Router } = require("express");
const {
  addGuildAdmin,
  getAdminStatus,
  listGuildAdmins,
} = require("../services/adminService");

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

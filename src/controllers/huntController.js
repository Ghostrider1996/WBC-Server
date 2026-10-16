const { Router } = require("express");
const { isOwner } = require("../services/adminService");
const { sessionFromRequest } = require("../services/sessionToken");
const hunt = require("../services/huntService");

const huntRouter = Router();

function requireOwner(req, res, next) {
  const session = sessionFromRequest(req);
  if (!session) {
    return res.status(401).json({ reason: "Sign in again to manage the hunt.", status: "failed" });
  }
  if (!isOwner({ discordId: session.discordId })) {
    return res.status(403).json({ reason: "Only the guild owner can manage the hunt.", status: "failed" });
  }
  return next();
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

huntRouter.param("id", (req, res, next, id) => {
  if (!UUID_PATTERN.test(id)) {
    return res.status(404).json({ reason: "Participant not found.", status: "failed" });
  }
  return next();
});

function handle(work, successStatus = 200) {
  return async (req, res) => {
    try {
      const data = await work(req);
      return res.status(successStatus).json(data);
    } catch (error) {
      const statusCode = error.statusCode || 500;
      if (statusCode >= 500) console.error("Hunt request failed:", error.message);
      return res.status(statusCode).json({
        reason: statusCode >= 500 ? "The hunt board could not be updated." : error.message,
        status: "failed",
      });
    }
  };
}

huntRouter.get("/hunt/live", handle(() => hunt.getSnapshot()));
huntRouter.get("/hunt/stream", (req, res) => hunt.openStream(req, res));

huntRouter.post("/hunt/participants", requireOwner, handle((req) => hunt.addParticipant(req.body?.name), 201));
huntRouter.post("/hunt/participants/:id/start", requireOwner, handle((req) => hunt.startParticipant(req.params.id)));
huntRouter.post("/hunt/participants/:id/pause", requireOwner, handle((req) => hunt.pauseParticipant(req.params.id)));
huntRouter.post("/hunt/participants/:id/reset", requireOwner, handle((req) => hunt.resetParticipant(req.params.id)));
huntRouter.post("/hunt/participants/:id/stop", requireOwner, handle((req) => hunt.stopParticipant(req.params.id)));
huntRouter.post(
  "/hunt/participants/:id/locations",
  requireOwner,
  handle((req) => hunt.changeLocations(req.params.id, Number(req.body?.delta))),
);
huntRouter.delete("/hunt/participants/:id", requireOwner, handle((req) => hunt.deleteParticipant(req.params.id)));
huntRouter.post("/hunt/events", requireOwner, handle((req) => hunt.startNewEvent(req.body?.name), 201));

module.exports = huntRouter;

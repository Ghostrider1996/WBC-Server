const raidHelperRouter = require("../controllers/raidHelperController");
const discordAuthRouter = require("../controllers/discordAuthController");
const blizzardAuthRouter = require("../controllers/blizzardAuthController");
const applicationRouter = require("../controllers/applicationController");
const contentRouter = require("../controllers/contentController");
const characterRouter = require("../controllers/characterController");
const raidAssignmentsRouter = require("../controllers/raidAssignmentsController");
const recruitmentRouter = require("../controllers/recruitmentController");

function configRoutes(app) {
  app.use("/api", raidHelperRouter);
  app.use("/api", discordAuthRouter);
  app.use("/api", blizzardAuthRouter);
  app.use("/api", applicationRouter);
  app.use("/api", contentRouter);
  app.use("/api", characterRouter);
  app.use("/api", raidAssignmentsRouter);
  app.use("/api", recruitmentRouter);
}

module.exports = { configRoutes };

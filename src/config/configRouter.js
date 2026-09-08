const raidHelperRouter = require("../controllers/raidHelperController");
const discordAuthRouter = require("../controllers/discordAuthController");
const applicationRouter = require("../controllers/applicationController");

function configRoutes(app) {
  app.use("/api", raidHelperRouter);
  app.use("/api", discordAuthRouter);
  app.use("/api", applicationRouter);
}

module.exports = { configRoutes };

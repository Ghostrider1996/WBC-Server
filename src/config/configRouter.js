const raidHelperRouter = require("../controllers/raidHelperController");
const discordAuthRouter = require("../controllers/discordAuthController");
const applicationRouter = require("../controllers/applicationController");
const contentRouter = require("../controllers/contentController");

function configRoutes(app) {
  app.use("/api", raidHelperRouter);
  app.use("/api", discordAuthRouter);
  app.use("/api", applicationRouter);
  app.use("/api", contentRouter);
}

module.exports = { configRoutes };

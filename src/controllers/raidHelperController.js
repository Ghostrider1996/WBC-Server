const { Router } = require("express");
const { getServerEvents } = require("../services/raidHelperService");

const raidHelperRouter = Router();

raidHelperRouter.get("/raid-helper/events", async (req, res) => {
  try {
    const response = await getServerEvents();
    return res.status(200).json(response.postedEvents ?? []);
  } catch (error) {
    const statusCode = error.response?.status || error.statusCode || 500;
    const reason = error.response?.data?.reason;

    console.error("Raid Helper events request failed:", statusCode, reason || error.message);

    return res.status(statusCode).json({
      reason: reason || error.message,
      status: "failed",
    });
  }
});

module.exports = raidHelperRouter;

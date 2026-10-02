const { Router } = require("express");
const { fetchWowheadNews } = require("../services/wowheadNewsService");

const wowheadNewsRouter = Router();

wowheadNewsRouter.get("/wowhead-news", async (req, res) => {
  try {
    const requested = Number.parseInt(req.query.limit, 10);
    const news = await fetchWowheadNews(Number.isInteger(requested) ? requested : 3);
    return res.status(200).json(news);
  } catch (error) {
    const statusCode = error.statusCode || 502;
    if (statusCode >= 500) {
      console.error("Wowhead news could not be loaded.", error.message);
    }

    return res.status(statusCode).json({
      reason: "Wowhead news could not be loaded.",
      status: "failed",
    });
  }
});

module.exports = wowheadNewsRouter;

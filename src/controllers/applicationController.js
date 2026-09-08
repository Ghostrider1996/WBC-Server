const { Router } = require("express");
const { submitApplication } = require("../services/discordWebhookService");

const applicationRouter = Router();
const allowedTypes = new Set(["verification", "guild", "officer"]);

applicationRouter.post("/applications", async (req, res) => {
  const { type, fields } = req.body;

  if (!allowedTypes.has(type) || !fields || typeof fields !== "object" || Array.isArray(fields)) {
    return res.status(400).json({ reason: "Invalid application payload", status: "failed" });
  }

  try {
    await submitApplication(type, fields);
    return res.status(201).json({ status: "submitted" });
  } catch (error) {
    const statusCode = error.response?.status ? 502 : error.statusCode || 500;
    console.error("Discord application webhook failed:", statusCode, error.message);

    return res.status(statusCode).json({
      reason: error.message,
      status: "failed",
    });
  }
});

module.exports = applicationRouter;

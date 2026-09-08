const axios = require("axios");

const applicationLabels = {
  verification: "Character Check",
  guild: "Guild Application",
  officer: "Officer Application",
};

function getWebhookUrl(applicationType) {
  const webhookUrls = {
    verification: process.env.DISCORD_CHARACTER_CHECK_WEBHOOK_URL,
    guild: process.env.DISCORD_GUILD_APPLICATION_WEBHOOK_URL,
    officer: process.env.DISCORD_OFFICER_APPLICATION_WEBHOOK_URL,
  };
  const webhookUrl = webhookUrls[applicationType];

  if (!webhookUrl) {
    const error = new Error(`Discord webhook configuration is missing for ${applicationType}`);
    error.statusCode = 500;
    throw error;
  }

  return webhookUrl;
}

function cleanValue(value) {
  return String(value || "").trim().slice(0, 1000);
}

async function submitApplication(applicationType, fields) {
  const webhookUrl = getWebhookUrl(applicationType);
  const label = applicationLabels[applicationType];
  const submittedFields = Object.entries(fields)
    .map(([name, value]) => ({
      name: cleanValue(name),
      value: cleanValue(value) || "Not provided",
      inline: false,
    }))
    .filter((field) => field.name);

  try {
    await axios.post(webhookUrl, {
      embeds: [{
        title: label,
        color: 13882323,
        fields: submittedFields,
        footer: { text: "Submitted from WBC Web Client" },
        timestamp: new Date().toISOString(),
      }],
    });
  } catch (error) {
    const webhookError = new Error(`${label} webhook rejected the request`);
    webhookError.statusCode = error.response?.status || 502;
    throw webhookError;
  }
}

module.exports = { submitApplication };

const axios = require("axios");

const applicationLabels = {
  verification: "Character Check",
  guild: "Guild Application",
  officer: "Officer Application",
};

const fieldLabels = {
  characterName: "Character Name",
  className: "Main Class",
  spec: "Specialization",
  specialization: "Specialization",
  offSpec: "Off-Specialization",
  offSpecialization: "Off-Specialization",
  altClass: "Alt Class",
  availability: "Raid Availability",
  introduction: "Introduction",
  account: "Account",
  armoryLink: "Armory Link",
  warcraftLogsLink: "Warcraft Logs Link",
  notes: "Verification Notes",
  rank: "Preferred Rank",
  experience: "Leadership Experience",
  goals: "Goals for the Guild",
};

const linkLabels = {
  armoryLink: "Armory Link",
  warcraftLogsLink: "Warcraft Logs Link",
};

const privateVerificationFields = new Set(["account", "discordAccount", "discordTag", "discordUsername"]);

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

function getFieldLabel(name) {
  return fieldLabels[name] || name.replace(/([A-Z])/g, " $1").replace(/^./, (character) => character.toUpperCase());
}

function formatFieldValue(name, value) {
  const cleanedValue = cleanValue(value);
  if (!cleanedValue) return "Not provided";

  const linkLabel = linkLabels[name];
  return linkLabel && /^https?:\/\//i.test(cleanedValue)
    ? `[${linkLabel}](${cleanedValue})`
    : cleanedValue;
}

async function submitApplication(applicationType, fields) {
  const webhookUrl = getWebhookUrl(applicationType);
  const label = applicationLabels[applicationType];
  const submittedFields = Object.entries(fields)
    .filter(([name]) => !(applicationType === "verification" && privateVerificationFields.has(name)))
    .map(([name, value]) => ({
      name: getFieldLabel(name),
      value: formatFieldValue(name, value),
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

const axios = require("axios");

const applicationLabels = {
  verification: "Verification Form",
  guild: "Guild Application",
  officer: "Officer Application",
};

const fieldLabels = {
  characterName: "Character Name",
  className: "Character Class",
  spec: "Main Specialization",
  specialization: "Main Specialization",
  offSpec: "Off Specialization",
  offSpecialization: "Off Specialization",
  altClass: "Alt Class",
  availability: "Raid Availability",
  introduction: "Introduction",
  account: "Account",
  armoryLink: "Classic Armory",
  warcraftLogsLink: "WarcraftLogs",
  rank: "Preferred Rank",
  experience: "Leadership Experience",
  goals: "Goals for the Guild",
  notes: "Verification Notes",
};

const linkLabels = {
  armoryLink: ":link: My Armory",
  warcraftLogsLink: ":link: My Logs",
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

function sanitizeApplicant(applicant) {
  if (!applicant || typeof applicant !== "object" || Array.isArray(applicant)) {
    return null;
  }

  const discordId = String(applicant.discordId || applicant.id || "").replace(/\D/g, "").slice(0, 32);
  const username = cleanValue(applicant.username).slice(0, 32);
  const globalName = cleanValue(applicant.globalName || applicant.global_name || username).slice(0, 80);
  const avatar = cleanValue(applicant.avatar).replace(/[^a-zA-Z0-9_]/g, "").slice(0, 64);

  if (!discordId && !username) return null;

  return { discordId, username, globalName, avatar };
}

function formatApplicantField(applicant) {
  const parts = [];

  if (applicant.discordId) parts.push(`<@${applicant.discordId}>`);
  if (applicant.username) parts.push(`@${applicant.username}`);
  if (applicant.globalName && applicant.globalName.toLowerCase() !== applicant.username.toLowerCase()) {
    parts.push(applicant.globalName);
  }

  return parts.join(" · ") || "Unknown";
}

function getApplicantAuthor(applicant) {
  if (!applicant) return undefined;

  const handle = applicant.username ? `@${applicant.username}` : "";
  const name = [applicant.globalName || handle, handle && applicant.globalName ? handle : ""]
    .filter(Boolean)
    .join(" ")
    .slice(0, 256) || "Discord member";

  const author = { name };

  if (applicant.discordId && applicant.avatar) {
    author.icon_url = `https://cdn.discordapp.com/avatars/${applicant.discordId}/${applicant.avatar}.png?size=64`;
  }

  return author;
}

async function submitApplication(applicationType, fields, applicantPayload) {
  const webhookUrl = getWebhookUrl(applicationType);
  const label = applicationLabels[applicationType];
  const applicant = sanitizeApplicant(applicantPayload);

  // Extract notes so it can be appended last
  const {
    notes,
    verificationNotes,
    discordId,
    discordUsername,
    discordDisplayName,
    discordTag,
    discordAccount,
    ...otherFields
  } = fields;
  const notesContent = notes || verificationNotes;

  const entries = Object.entries(otherFields);
  if (notesContent) {
    entries.push(["notes", notesContent]);
  }

  const submittedFields = entries
    .filter(([name]) => !(applicationType === "verification" && privateVerificationFields.has(name)))
    .map(([name, value]) => ({
      name: getFieldLabel(name),
      value: formatFieldValue(name, value),
      inline: false,
    }))
    .filter((field) => field.name && field.value);

  if (applicant) {
    submittedFields.unshift({
      name: "Discord",
      value: formatApplicantField(applicant),
      inline: false,
    });
  }

  const LOGO_URL = "https://i.postimg.cc/2y7YQNLt/WBC-Logo.png";
  const DEFAULT_BANNER = "https://i.postimg.cc/PfQnFhPs/file-000000007bf882468e45a7f7dd58c06d.png";

  try {
    await axios.post(webhookUrl, {
      embeds: [{
        title: label,
        color: 255,
        author: getApplicantAuthor(applicant),
        fields: submittedFields,
        footer: { text: "Submitted from WBC Web Client" },
        thumbnail: { url: LOGO_URL },
        image: { url: DEFAULT_BANNER },
        timestamp: new Date().toISOString(),
      }],
    });
  } catch (error) {
    const webhookError = new Error(`${label} webhook rejected the request`);
    webhookError.statusCode = error.response?.status || 502;
    throw webhookError;
  }
}

const MAGTHERIDON_DIAGRAM_URL = "https://wbchq-assets.s3.us-east-1.amazonaws.com/discord/magtheridon_diagram.png";

function cleanSectionValue(value) {
  const text = String(value || "").trim();
  return text.slice(0, 1024) || "None set";
}

async function pushRaidAssignments({ title, sections, includeImage, eventId }) {
  const webhookUrl = process.env.DISCORD_ASSIGNMENTS_WEBHOOK_URL;

  if (!webhookUrl) {
    const error = new Error("Discord assignments webhook is not configured");
    error.statusCode = 500;
    throw error;
  }

  const fields = (Array.isArray(sections) ? sections : [])
    .slice(0, 25)
    .map((section) => ({
      name: String(section?.name || "Assignment").trim().slice(0, 256) || "Assignment",
      value: cleanSectionValue(section?.value),
      inline: false,
    }))
    .filter((field) => field.name);

  if (fields.length === 0) {
    const error = new Error("No assignment sections were provided");
    error.statusCode = 400;
    throw error;
  }

  const embed = {
    title: String(title || "Raid assignments").trim().slice(0, 256) || "Raid assignments",
    color: 9127188,
    fields,
    timestamp: new Date().toISOString(),
    footer: { text: eventId ? `Event ${String(eventId).slice(0, 80)}` : "WBC Raid Assignments" },
  };

  if (includeImage !== false) {
    embed.image = { url: MAGTHERIDON_DIAGRAM_URL };
  }

  try {
    await axios.post(webhookUrl, { embeds: [embed] });
  } catch (error) {
    const webhookError = new Error("Assignments webhook rejected the request");
    webhookError.statusCode = error.response?.status || 502;
    throw webhookError;
  }
}

module.exports = { submitApplication, pushRaidAssignments };

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

const ASSET_BASE_URL = "https://wbchq-assets.s3.us-east-1.amazonaws.com/discord";

// Same class colors the website uses (WBC_Wrbpage/src/services/wowIcons.js).
const CLASS_COLORS = {
  warrior: "#C79C6E",
  paladin: "#F58CBA",
  hunter: "#ABD473",
  rogue: "#FFF569",
  // Discord ignores a pure #FFFFFF embed color and shows the default dark border, so use the nearest white.
  priest: "#FFFFFE",
  shaman: "#0070DE",
  mage: "#69CCF0",
  warlock: "#9482C9",
  druid: "#FF7D0A",
};

// The form sends the class with its emoji in front, e.g. "<:hunter:123> Hunter".
function detectClassKey(value) {
  const text = String(value || "")
    .replace(/<a?:\w+:\d+>/g, " ")
    .replace(/:\w+:/g, " ")
    .toLowerCase();

  return Object.keys(CLASS_COLORS).find((key) => new RegExp(`\\b${key}\\b`).test(text)) || "";
}

function getClassPresentation(applicationType, fields) {
  if (applicationType !== "guild" && applicationType !== "verification") return null;

  const classKey = detectClassKey(fields?.className);
  if (!classKey) return null;

  return {
    banner: `${ASSET_BASE_URL}/${classKey}_banner.jpg`,
    color: parseInt(CLASS_COLORS[classKey].slice(1), 16),
  };
}

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

  const LOGO_URL = "https://i.postimg.cc/2y7YQNLt/WBC-Logo.png";
  const DEFAULT_BANNER = "https://i.postimg.cc/PfQnFhPs/file-000000007bf882468e45a7f7dd58c06d.png";

  // Guild and verification forms get the character's class banner and color instead of the guild banner.
  const classLook = getClassPresentation(applicationType, fields);

  try {
    await axios.post(webhookUrl, {
      embeds: [{
        title: label,
        color: classLook?.color ?? 255,
        author: getApplicantAuthor(applicant),
        fields: submittedFields,
        footer: { text: "Submitted from WBC Web Client" },
        thumbnail: { url: LOGO_URL },
        image: { url: classLook?.banner ?? DEFAULT_BANNER },
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

const ASSIGNMENT_CHANNELS = {
  "1512229796900241510": "Saturday events",
  "1512233253178704104": "Sunday events",
  "1572025563747459182": "F-Team assignments",
  "1572025615274741850": "E-Team assignments",
  "1554020208190955530": "C-Team assignments",
  "1554020441339723856": "D-Team assignments",
  "1566431068347699270": "B-Team assignments",
  "1554020645812051988": "A-Team assignments",
  "1547310122680721483": "K-Twenty assignments",
  "1554074940599435365": "S-Twenty assignments",
  "1572025766139531426": "W-Twenty assignments",
};

const CHANNEL_WEBHOOKS = {
  "1512229796900241510": "DISCORD_ASSIGNMENTS_WEBHOOK_SATURDAY",
  "1512233253178704104": "DISCORD_ASSIGNMENTS_WEBHOOK_SUNDAY",
};

function webhookForChannel(channelId) {
  const envName = CHANNEL_WEBHOOKS[String(channelId || "").trim()];
  return envName ? cleanEnvValue(process.env[envName]) : "";
}

let assignmentPushQueue = Promise.resolve();

function enqueueAssignmentPush(task) {
  const run = assignmentPushQueue.then(task, task);
  assignmentPushQueue = run.then(() => undefined, () => undefined);
  return run;
}

function cleanEnvValue(value) {
  if (!value || typeof value !== "string") return "";
  return value.split("#")[0].trim();
}

function assignmentError(message, statusCode) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

async function webhookChannelId(webhookUrl) {
  const response = await axios.get(webhookUrl);
  return String(response.data?.channel_id || "");
}

function roleMentionId(roleId) {
  const id = String(roleId || "").replace(/\D/g, "");
  return /^\d{17,20}$/.test(id) ? id : "";
}

function mentionPayload(embed, roleId) {
  const id = roleMentionId(roleId);
  const payload = { embeds: [embed] };
  if (!id) return payload;
  payload.content = `<@&${id}>`;
  payload.allowed_mentions = { parse: [], roles: [id] };
  return payload;
}

function discordErrorDetail(error) {
  const data = error?.response?.data;
  if (!data || typeof data !== "object") return "";
  const message = typeof data.message === "string" ? data.message.trim() : "";
  if (!message || /https?:\/\//i.test(message)) return "";
  const code = data.code ? ` (${data.code})` : "";
  return `${message}${code}`.slice(0, 240);
}

async function postWithWebhook(webhookUrl, embed, roleId) {
  const response = await axios.post(`${webhookUrl}?wait=true`, mentionPayload(embed, roleId));
  return response.data?.id ? String(response.data.id) : "";
}

async function moveWebhook(webhookUrl, channelId, botToken) {
  const match = String(webhookUrl).match(/\/webhooks\/(\d+)\//);
  if (!match) return false;
  await axios.patch(
    `https://discord.com/api/v10/webhooks/${match[1]}`,
    { channel_id: channelId },
    { headers: { Authorization: `Bot ${botToken}` } },
  );
  return await webhookChannelId(webhookUrl) === String(channelId);
}

async function postWithBot(channelId, embed, botToken, roleId) {
  await axios.post(
    `https://discord.com/api/v10/channels/${channelId}/messages`,
    mentionPayload(embed, roleId),
    { headers: { Authorization: `Bot ${botToken}` } },
  );
}

async function deliverAssignment(webhookUrl, channelId, embed, roleId) {
  const channelKey = String(channelId || "").trim();
  const dedicated = webhookForChannel(channelKey);
  if (CHANNEL_WEBHOOKS[channelKey] && !dedicated) {
    const label = ASSIGNMENT_CHANNELS[channelKey] || "That channel";
    throw assignmentError(
      `${label} is not configured on this server. Set ${CHANNEL_WEBHOOKS[channelKey]} and restart the server.`,
      400,
    );
  }
  if (dedicated) {
    try {
      return await postWithWebhook(dedicated, embed, roleId);
    } catch (error) {
      const detail = discordErrorDetail(error);
      throw assignmentError(
        detail
          ? `The assignments webhook rejected the request. ${detail}`
          : "The assignments webhook rejected the request.",
        error.response?.status || 502,
      );
    }
  }

  const botToken = cleanEnvValue(process.env.DISCORD_BOT_TOKEN);
  let currentChannel = "";
  try {
    currentChannel = await webhookChannelId(webhookUrl);
  } catch {
    currentChannel = "";
  }

  if (currentChannel === String(channelId)) {
    return await postWithWebhook(webhookUrl, embed, roleId);
  }

  if (!botToken) {
    throw assignmentError(
      "This webhook can only post in the channel it was created in. Add DISCORD_BOT_TOKEN on the server so assignments can go to the channel you pick.",
      400,
    );
  }

  try {
    if (await moveWebhook(webhookUrl, channelId, botToken)) {
      return await postWithWebhook(webhookUrl, embed, roleId);
    }
  } catch {
    // The bot may not be allowed to move the webhook. Post into the channel directly.
  }

  try {
    await postWithBot(channelId, embed, botToken, roleId);
  } catch (error) {
    const status = error.response?.status;
    if (status === 403 || status === 404) {
      throw assignmentError("The bot cannot post in that channel. It needs permission to send messages there.", status);
    }
    throw assignmentError("The assignment could not be posted in that channel.", status || 502);
  }
}

async function pushRaidAssignments({ title, sections, includeImage, eventId, channelId, roleId }) {
  const webhookUrl = webhookForChannel(channelId) || cleanEnvValue(process.env.DISCORD_ASSIGNMENTS_WEBHOOK_URL);

  if (!webhookUrl) {
    const error = new Error("Discord assignments webhook is not configured");
    error.statusCode = 500;
    throw error;
  }

  const selectedChannel = ASSIGNMENT_CHANNELS[String(channelId || "").trim()];
  if (!selectedChannel) {
    const error = new Error("Choose an assignment channel.");
    error.statusCode = 400;
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
    footer: {
      text: [selectedChannel, eventId ? `Event ${String(eventId).slice(0, 80)}` : "WBC Raid Assignments"]
        .join(" · ")
        .slice(0, 2048),
    },
  };

  if (includeImage === true) {
    embed.image = { url: MAGTHERIDON_DIAGRAM_URL };
  }

  return enqueueAssignmentPush(() => deliverAssignment(webhookUrl, String(channelId).trim(), embed, roleId));
}

module.exports = { submitApplication, pushRaidAssignments };

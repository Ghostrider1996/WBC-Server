const axios = require("axios");

const raidHelperClient = axios.create({
  baseURL: "https://raid-helper.xyz/api/v4",
  headers: {
    Accept: "application/json",
  },
});

const TANK_SPECS = {
  warrior: "Protection",
  paladin: "Protection1",
  druid: "Guardian",
};

const TBC_ANNIVERSARY_TEMPLATE = "wowtbc";
const WOW_SIGNUP_CLASSES = new Set([
  "warrior",
  "paladin",
  "hunter",
  "rogue",
  "priest",
  "shaman",
  "mage",
  "warlock",
  "druid",
  "tank",
]);

function cleanEnvValue(value) {
  if (!value || typeof value !== "string") return "";
  return value.split("#")[0].trim();
}

function getRaidHelperConfig() {
  const serverId = process.env.RAID_HELPER_SERVER_ID;
  const apiKey = process.env.RAID_HELPER_API_KEY;

  if (!serverId || !apiKey) {
    const error = new Error("Raid Helper server configuration is missing");
    error.statusCode = 500;
    throw error;
  }

  return { serverId, apiKey };
}

function authHeaders() {
  const { apiKey } = getRaidHelperConfig();
  return {
    Authorization: apiKey,
    Accept: "application/json",
    "Content-Type": "application/json",
  };
}

function compact(value) {
  return String(value || "").toLowerCase().replace(/[^a-z]/g, "");
}

function specKey(value) {
  return compact(value).replace(/\d+$/, "");
}

function wrapRaidHelperError(error, fallback) {
  const statusCode = error.statusCode || error.response?.status || 502;
  const payload = error.response?.data;
  const reason = payload?.reason
    || payload?.message
    || payload?.error
    || (typeof payload === "string" ? payload : "")
    || error.message
    || fallback;
  const wrapped = new Error(reason);
  wrapped.statusCode = statusCode >= 400 ? statusCode : 502;
  return wrapped;
}

function eventFromResponse(data) {
  return data?.event ?? data?.data ?? data;
}

function findTemplateClass(classes, name) {
  const key = compact(name);
  return (classes || []).find((entry) => compact(entry.name) === key || compact(entry.cName) === key) || null;
}

function findTemplateSpec(klass, specName) {
  const key = specKey(specName);
  if (!klass || !key) return null;

  const specs = klass.specs || [];
  return specs.find((spec) => specKey(spec.name) === key || specKey(spec.cName) === key)
    || specs.find((spec) => {
      const candidate = specKey(spec.name) || specKey(spec.cName);
      return candidate.startsWith(key) || key.startsWith(candidate);
    })
    || null;
}

function pickSpecByRole(klass, roleName) {
  const key = compact(roleName);
  return (klass?.specs || []).find((spec) => compact(spec.roleName) === key) || null;
}

function templateSelection(klass, spec) {
  if (!klass || !spec) return null;

  return {
    className: klass.name || klass.cName,
    specName: spec.name || spec.cName || "",
    roleName: spec.roleName || spec.cRoleName || "",
    classEmoteId: klass.emoteId || null,
    specEmoteId: spec.emoteId || null,
    roleEmoteId: spec.roleEmoteId || null,
  };
}

function matchCharacterToTemplate(event, character) {
  const classes = event?.classes || [];
  const className = character.class;
  const specName = character.spec;
  const role = String(character.role || "").toLowerCase();

  if (role === "tank") {
    const tankClass = findTemplateClass(classes, "Tank");
    const preferredSpec = specName || TANK_SPECS[compact(className)] || "";
    const tankSpec = findTemplateSpec(tankClass, preferredSpec)
      || findTemplateSpec(tankClass, TANK_SPECS[compact(className)]);
    const selection = templateSelection(tankClass, tankSpec);
    if (selection) return selection;
  }

  const klass = findTemplateClass(classes, className);
  if (!klass) return null;

  let spec = specName ? findTemplateSpec(klass, specName) : null;
  if (!spec && role === "healer") spec = pickSpecByRole(klass, "Healers");
  if (!spec && role === "tank") spec = pickSpecByRole(klass, "Tanks");
  if (!spec) {
    spec = (klass.specs || []).find((entry) => ["melee", "ranged", "dps"].includes(compact(entry.roleName)))
      || (klass.specs || [])[0]
      || null;
  }

  return templateSelection(klass, spec);
}

function matchStatusClass(event, status) {
  const names = status === "tentative"
    ? ["Tentative", "Maybe"]
    : ["Absence", "Absent", "Declined"];

  for (const name of names) {
    const klass = findTemplateClass(event?.classes || [], name);
    if (klass) {
      return {
        className: klass.name || klass.cName,
        specName: "",
      };
    }
  }

  return {
    className: names[0],
    specName: "",
  };
}

function matchGenericSignup(event) {
  const skipped = new Set(["tentative", "maybe", "absence", "absent", "declined", "late"]);
  const classes = event?.classes || [];
  const klass = classes.find((entry) => !skipped.has(compact(entry.name || entry.cName)))
    || classes[0]
    || null;

  if (!klass) {
    return { className: "Accepted", specName: "" };
  }

  const spec = (klass.specs || [])[0] || null;
  return templateSelection(klass, spec) || {
    className: klass.name || klass.cName,
    specName: spec?.name || spec?.cName || "",
    roleName: spec?.roleName || spec?.cRoleName || "",
  };
}

function hasWowSignupClasses(event) {
  return (event?.classes || []).some((entry) => WOW_SIGNUP_CLASSES.has(compact(entry.name || entry.cName)));
}

function isGenericRaidHelperEvent(event) {
  return !hasWowSignupClasses(event);
}

function findExistingSignup(event, userId) {
  const collections = [event.signUps, event.signups, event.participants];
  for (const collection of collections) {
    if (!Array.isArray(collection)) continue;
    const match = collection.find((signup) => String(signup.userId ?? signup.user?.id ?? "") === String(userId));
    if (match) return match;
  }
  return null;
}

function compactPayload(payload) {
  return Object.fromEntries(
    Object.entries(payload).filter(([, value]) => value !== undefined && value !== null && value !== ""),
  );
}

async function getServerEvents() {
  const { serverId, apiKey } = getRaidHelperConfig();

  const response = await raidHelperClient.get(`/servers/${serverId}/events`, {
    params: {
      IncludeSignUps: true,
    },
    headers: {
      Authorization: apiKey,
    },
  });

  const events = response.data.postedEvents ?? [];
  const detailedEvents = await Promise.all(
    events.map(async (event) => {
      try {
        const detailResponse = await raidHelperClient.get(`/events/${event.id}`);
        const detail = eventFromResponse(detailResponse.data);

        if (!detail || typeof detail !== "object") return event;

        const nonEmptyDetail = Object.fromEntries(
          Object.entries(detail).filter(([, value]) => value !== null && value !== undefined && value !== ""),
        );

        return { ...event, ...nonEmptyDetail };
      } catch (error) {
        console.error(`Raid Helper event details request failed for ${event.id}:`, error.message);
        return event;
      }
    }),
  );

  return { ...response.data, postedEvents: detailedEvents };
}

async function getEventById(eventId) {
  const { apiKey } = getRaidHelperConfig();

  try {
    const response = await raidHelperClient.get(`/events/${eventId}`, {
      headers: { Authorization: apiKey },
    });
    const event = eventFromResponse(response.data);
    if (event && typeof event === "object") return event;
  } catch (error) {
    if (error.response?.status !== 404) {
      throw wrapRaidHelperError(error, "The raid event could not be loaded.");
    }
  }

  const { postedEvents } = await getServerEvents();
  const event = (postedEvents || []).find((entry) => String(entry.id) === String(eventId));
  if (!event) {
    const missing = new Error("That raid event was not found.");
    missing.statusCode = 404;
    throw missing;
  }
  return event;
}

async function sendSignupRequest(method, url, payload) {
  const response = await raidHelperClient.request({
    method,
    url,
    data: payload,
    headers: authHeaders(),
  });
  return response.data;
}

async function saveSignup(eventId, payload, existingSignup) {
  const body = compactPayload(payload);

  if (existingSignup) {
    const signupId = existingSignup.id || existingSignup.position || existingSignup.name;
    try {
      return await sendSignupRequest("patch", `/events/${eventId}/signups/${encodeURIComponent(String(signupId))}`, body);
    } catch (error) {
      if (![404, 405, 501].includes(error.response?.status)) {
        throw wrapRaidHelperError(error, "The raid sign-up could not be updated.");
      }
    }
  }

  try {
    return await sendSignupRequest("post", `/events/${eventId}/signups`, body);
  } catch (error) {
    throw wrapRaidHelperError(error, "The raid sign-up could not be updated.");
  }
}

async function signUpForEvent({ eventId, userId, character, status, displayName, event: loadedEvent }) {
  const event = loadedEvent || await getEventById(eventId);
  const generic = isGenericRaidHelperEvent(event);
  const signupStatus = status === "tentative" || status === "absence" ? status : "primary";
  const selection = signupStatus === "primary"
    ? (generic ? matchGenericSignup(event) : matchCharacterToTemplate(event, character))
    : matchStatusClass(event, signupStatus);

  if (!selection) {
    const error = new Error(generic
      ? "This event does not have a sign-up option available."
      : "That character does not match a class or spec on this raid.");
    error.statusCode = 400;
    throw error;
  }

  return saveSignup(eventId, {
    userId: String(userId),
    className: selection.className,
    specName: selection.specName || undefined,
    name: character?.name || displayName || undefined,
  }, findExistingSignup(event, userId));
}

async function deleteEvent(eventId) {
  try {
    await raidHelperClient.delete(`/events/${eventId}`, { headers: authHeaders() });
  } catch (error) {
    throw wrapRaidHelperError(error, "The raid event could not be deleted.");
  }
}

function envChannel(name) {
  return cleanEnvValue(process.env[name]);
}

function isKarazhanEvent(raid, title) {
  const text = `${raid || ""} ${title || ""}`.toLowerCase();
  return /\bkara(?:zhan)?\b/.test(text);
}

function getCalendarWeekday(value) {
  if (typeof value === "string") {
    const isoMatch = value.trim().match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (isoMatch) {
      return new Date(Number(isoMatch[1]), Number(isoMatch[2]) - 1, Number(isoMatch[3])).getDay();
    }
    const dmyMatch = value.trim().match(/^(\d{1,2})-(\d{1,2})-(\d{4})$/);
    if (dmyMatch) {
      return new Date(Number(dmyMatch[3]), Number(dmyMatch[2]) - 1, Number(dmyMatch[1])).getDay();
    }
  }

  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? -1 : date.getDay();
}

function requireChannel(channelId, envName, label) {
  if (channelId) return channelId;
  const error = new Error(`Set ${envName} in the API .env for ${label}.`);
  error.statusCode = 400;
  throw error;
}

function normalizeChannelChoice(channel) {
  const value = String(channel || "").trim().toLowerCase();
  if (value === "saturday" || value === "sat") return "saturday";
  if (value === "sunday" || value === "sun") return "sunday";
  return "";
}

function saturdayChannel() {
  return requireChannel(
    envChannel("RAID_HELPER_SATURDAY_CHANNEL_ID"),
    "RAID_HELPER_SATURDAY_CHANNEL_ID",
    "Saturday raids",
  );
}

function sundayChannel() {
  return requireChannel(
    envChannel("RAID_HELPER_SUNDAY_CHANNEL_ID") || envChannel("RAID_HELPER_CHANNEL_ID"),
    "RAID_HELPER_SUNDAY_CHANNEL_ID",
    "Sunday raids",
  );
}

function resolveChannelId({ raid, title, date, channel } = {}) {
  if (isKarazhanEvent(raid, title)) {
    return requireChannel(
      envChannel("RAID_HELPER_KARA_CHANNEL_ID"),
      "RAID_HELPER_KARA_CHANNEL_ID",
      "Karazhan events",
    );
  }

  const choice = normalizeChannelChoice(channel);
  if (choice === "saturday") return saturdayChannel();
  if (choice === "sunday") return sundayChannel();

  const weekday = getCalendarWeekday(date);
  if (weekday === 6) return saturdayChannel();
  if (weekday === 0) return sundayChannel();

  const error = new Error("Choose the Saturday or Sunday Discord channel.");
  error.statusCode = 400;
  throw error;
}

function toRaidHelperDate(value) {
  if (typeof value === "string") {
    const isoMatch = value.trim().match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (isoMatch) return `${isoMatch[3]}-${isoMatch[2]}-${isoMatch[1]}`;
    const dmyMatch = value.trim().match(/^(\d{1,2})-(\d{1,2})-(\d{4})$/);
    if (dmyMatch) {
      return `${dmyMatch[1].padStart(2, "0")}-${dmyMatch[2].padStart(2, "0")}-${dmyMatch[3]}`;
    }
  }

  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const day = String(date.getDate()).padStart(2, "0");
  const month = String(date.getMonth() + 1).padStart(2, "0");
  return `${day}-${month}-${date.getFullYear()}`;
}

function toRaidHelperTime(value) {
  if (typeof value === "string") {
    const match = value.trim().match(/^(\d{1,2}):(\d{2})(?::\d{2})?$/);
    if (match) return `${String(match[1]).padStart(2, "0")}:${match[2]}`;
  }

  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

async function createEvent({
  title,
  description,
  date,
  time,
  raid,
  leaderId,
  duration,
  limit,
  image,
  channel,
}) {
  const eventTitle = String(title || "").trim();
  const eventDate = toRaidHelperDate(date);
  const eventTime = toRaidHelperTime(time);
  const eventLeaderId = String(leaderId || "").trim();

  if (!eventTitle || !eventDate || !eventTime || !eventLeaderId) {
    const error = new Error("Title, date, time, and a Discord account are required.");
    error.statusCode = 400;
    throw error;
  }

  const { serverId } = getRaidHelperConfig();
  const resolvedChannelId = resolveChannelId({ raid, title: eventTitle, date, channel });

  const advancedSettings = compactPayload({
    duration: Number(duration) > 0 ? Number(duration) : undefined,
    limit: Number(limit) > 0 ? Number(limit) : undefined,
    image: String(image || "").trim() || undefined,
    description: String(description || "").trim() || undefined,
  });

  try {
    const response = await raidHelperClient.post(
      `/servers/${serverId}/channels/${resolvedChannelId}/event`,
      compactPayload({
        leaderId: eventLeaderId,
        templateId: TBC_ANNIVERSARY_TEMPLATE,
        date: eventDate,
        time: eventTime,
        title: eventTitle,
        description: String(description || "").trim() || undefined,
        advancedSettings: Object.keys(advancedSettings).length ? advancedSettings : undefined,
      }),
      { headers: authHeaders() },
    );
    return eventFromResponse(response.data);
  } catch (error) {
    throw wrapRaidHelperError(error, "The raid event could not be created.");
  }
}

module.exports = { getServerEvents, getEventById, signUpForEvent, deleteEvent, createEvent, isGenericRaidHelperEvent };

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
  const className = status === "tentative" ? "Tentative" : "Absence";
  const klass = findTemplateClass(event?.classes || [], className);
  return {
    className: klass?.name || klass?.cName || className,
    specName: "",
  };
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

async function signUpForEvent({ eventId, userId, character, status }) {
  const event = await getEventById(eventId);
  const signupStatus = status === "tentative" || status === "absence" ? status : "primary";
  const selection = signupStatus === "primary"
    ? matchCharacterToTemplate(event, character)
    : matchStatusClass(event, signupStatus);

  if (!selection) {
    const error = new Error("That character does not match a class or spec on this raid.");
    error.statusCode = 400;
    throw error;
  }

  return saveSignup(eventId, {
    userId: String(userId),
    className: selection.className,
    specName: selection.specName || undefined,
    name: character?.name || undefined,
  }, findExistingSignup(event, userId));
}

async function deleteEvent(eventId) {
  try {
    await raidHelperClient.delete(`/events/${eventId}`, { headers: authHeaders() });
  } catch (error) {
    throw wrapRaidHelperError(error, "The raid event could not be deleted.");
  }
}

module.exports = { getServerEvents, signUpForEvent, deleteEvent };

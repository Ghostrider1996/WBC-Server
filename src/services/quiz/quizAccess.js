const raidHelperService = require("../raidHelperService");

const ABSENT_STATES = new Set(["absence", "absent", "declined"]);
const DEFAULT_TTL_MS = 30 * 1000;
const REFRESH_AFTER_MISS_MS = 5 * 1000;

function signupsOf(event) {
  for (const collection of [event?.signUps, event?.signups, event?.participants]) {
    if (Array.isArray(collection)) return collection;
  }
  return [];
}

function isPresentSignup(signup) {
  const labels = [signup.className, signup.status, signup.specName]
    .map((value) => String(value ?? "").trim().toLowerCase());
  return !labels.some((label) => ABSENT_STATES.has(label));
}

/** True when the Discord user is on the event's sign-up list and not marked absent. */
function isSignedUp(event, discordId) {
  const wanted = String(discordId);
  return signupsOf(event).some((signup) =>
    String(signup.userId ?? signup.user?.id ?? "") === wanted && isPresentSignup(signup));
}

/**
 * Looks up sign-ups through Raid Helper with a short cache, so a room full of
 * people joining at once costs one API call rather than one each. Failures are
 * not cached and are thrown so callers can refuse rather than guess.
 */
function createSignupChecker({ getEvent = raidHelperService.getEventById, ttlMs = DEFAULT_TTL_MS, now = Date.now } = {}) {
  const cache = new Map();
  const pending = new Map();

  async function loadEvent(eventId, maxAgeMs = ttlMs) {
    const cached = cache.get(eventId);
    if (cached && now() - cached.at < maxAgeMs) return cached.event;

    if (!pending.has(eventId)) {
      pending.set(eventId, getEvent(eventId)
        .then((event) => {
          cache.set(eventId, { event, at: now() });
          return event;
        })
        .finally(() => pending.delete(eventId)));
    }
    return pending.get(eventId);
  }

  return {
    async isSignedUp(eventId, discordId) {
      const id = String(eventId);
      if (isSignedUp(await loadEvent(id), discordId)) return true;
      // Someone may have signed up a moment ago: look again, but not on every attempt.
      return isSignedUp(await loadEvent(id, REFRESH_AFTER_MISS_MS), discordId);
    },
    forget(eventId) {
      cache.delete(String(eventId));
    },
  };
}

module.exports = { createSignupChecker, isSignedUp };

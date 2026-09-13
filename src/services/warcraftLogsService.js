const axios = require("axios");

let cachedToken = null;
let cachedTokenExpiresAt = 0;

function getApiUrl() {
  return process.env.WARCRAFTLOGS_API_URL || "https://fresh.warcraftlogs.com/api/v2/client";
}

function getSiteOrigin() {
  try {
    return new URL(getApiUrl()).origin;
  } catch {
    return "https://fresh.warcraftlogs.com";
  }
}

function characterUrl(region, realm, name) {
  const regionSlug = String(region || "eu").toLowerCase();
  const realmSlug = String(realm || "").toLowerCase().replace(/\s+/g, "-");
  const characterName = encodeURIComponent(String(name || "").toLowerCase());
  return `${getSiteOrigin()}/character/${regionSlug}/${realmSlug}/${characterName}`;
}

async function getAccessToken() {
  if (cachedToken && Date.now() < cachedTokenExpiresAt) {
    return cachedToken;
  }

  const clientId = process.env.WARCRAFTLOGS_CLIENT_ID;
  const clientSecret = process.env.WARCRAFTLOGS_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    throw new Error("Warcraft Logs API configuration is missing");
  }

  const tokenUrls = [
    process.env.WARCRAFTLOGS_TOKEN_URL,
    "https://www.warcraftlogs.com/oauth/token",
    `${getSiteOrigin()}/oauth/token`,
  ].filter(Boolean);

  let lastError;

  for (const tokenUrl of [...new Set(tokenUrls)]) {
    try {
      const response = await axios.post(
        tokenUrl,
        new URLSearchParams({ grant_type: "client_credentials" }),
        {
          auth: { username: clientId, password: clientSecret },
          headers: { Accept: "application/json" },
        },
      );

      cachedToken = response.data.access_token;
      cachedTokenExpiresAt = Date.now() + Math.max(60, Number(response.data.expires_in || 3600) - 60) * 1000;
      return cachedToken;
    } catch (error) {
      lastError = error;
    }
  }

  throw lastError || new Error("Warcraft Logs token request failed");
}

async function graphql(query, variables) {
  const token = await getAccessToken();
  const response = await axios.post(
    getApiUrl(),
    { query, variables },
    {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
        "Content-Type": "application/json",
      },
    },
  );

  if (response.data?.errors?.length) {
    throw new Error(response.data.errors[0].message);
  }

  return response.data.data;
}

function roundParse(value) {
  if (typeof value !== "number" || Number.isNaN(value)) {
    return null;
  }

  return Math.round(value);
}

function mapCharacterLogs(character, region, realm, name) {
  const rankings = character?.zoneRankings || {};
  const encounters = Array.isArray(rankings.rankings) ? rankings.rankings : [];
  const bossesKilled = encounters.reduce((sum, encounter) => (
    sum + (Number(encounter.totalKills) || 0)
  ), 0);

  return {
    found: Boolean(character?.id),
    hidden: Boolean(character?.hidden),
    bestParse: roundParse(rankings.bestPerformanceAverage),
    medianParse: roundParse(rankings.medianPerformanceAverage),
    bossesKilled,
    encountersLogged: encounters.length,
    zoneName: rankings.zone?.name || null,
    url: characterUrl(region, realm, name),
  };
}

async function fetchCharacterLogs({ name, realm, region }) {
  const data = await graphql(
    `
      query CharacterLogs($name: String!, $serverSlug: String!, $serverRegion: String!) {
        characterData {
          character(name: $name, serverSlug: $serverSlug, serverRegion: $serverRegion) {
            id
            name
            hidden
            zoneRankings
          }
        }
      }
    `,
    {
      name,
      serverSlug: String(realm || "").toLowerCase(),
      serverRegion: String(region || "eu").toLowerCase(),
    },
  );

  return mapCharacterLogs(data?.characterData?.character, region, realm, name);
}

function emptyLogs(character) {
  return {
    found: false,
    hidden: false,
    bestParse: null,
    medianParse: null,
    bossesKilled: 0,
    encountersLogged: 0,
    zoneName: null,
    url: characterUrl(character.region, character.realm, character.name),
  };
}

const logsCache = new Map();

function clearLogsCache() {
  logsCache.clear();
}

async function attachWarcraftLogs(characters) {
  const enriched = [];

  for (const character of characters) {
    const cacheKey = `${character.region}:${character.realm}:${character.name}`.toLowerCase();
    const cached = logsCache.get(cacheKey);

    if (cached && cached.expiresAt > Date.now()) {
      enriched.push({ ...character, warcraftlogsUrl: cached.logs.url, logs: cached.logs });
      continue;
    }

    try {
      const logs = await fetchCharacterLogs(character);
      logsCache.set(cacheKey, { logs, expiresAt: Date.now() + 15 * 60 * 1000 });
      enriched.push({ ...character, warcraftlogsUrl: logs.url, logs });
    } catch (error) {
      console.error("Warcraft Logs lookup failed:", character.name, error.message);
      const logs = emptyLogs(character);
      enriched.push({ ...character, warcraftlogsUrl: logs.url, logs });
    }
  }

  return enriched;
}

function summarizeLogs(characters) {
  const withParses = characters.filter((character) => character.logs?.found && !character.logs.hidden);
  const main = characters.find((character) => character.isMain) || withParses[0];
  const bestFromMain = main?.logs?.bestParse;
  const bestOverall = withParses.reduce((best, character) => (
    typeof character.logs.bestParse === "number" && character.logs.bestParse > (best || 0)
      ? character.logs.bestParse
      : best
  ), null);
  const bossesKilled = (main?.logs?.bossesKilled)
    || withParses.reduce((sum, character) => sum + (character.logs.bossesKilled || 0), 0);

  return {
    bestParse: bestFromMain ?? bestOverall,
    medianParse: main?.logs?.medianParse ?? null,
    bossesKilled: bossesKilled || null,
    zoneName: main?.logs?.zoneName || null,
  };
}

module.exports = {
  attachWarcraftLogs,
  summarizeLogs,
  characterUrl,
  clearLogsCache,
};

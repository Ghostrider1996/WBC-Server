const axios = require("axios");
const crypto = require("crypto");

const CLASS_NAMES = {
  1: "Warrior",
  2: "Paladin",
  3: "Hunter",
  4: "Rogue",
  5: "Priest",
  7: "Shaman",
  8: "Mage",
  9: "Warlock",
  11: "Druid",
};

function getRegion() {
  return (process.env.BLIZZARD_REGION || "eu").trim().toLowerCase();
}

function getNamespace() {
  return process.env.BLIZZARD_NAMESPACE || `profile-classicann-${getRegion()}`;
}

function getRedirectUri(explicitUri) {
  if (explicitUri) {
    return explicitUri;
  }

  return process.env.BLIZZARD_REDIRECT_URI || "http://localhost:3030/api/auth/battlenet/callback";
}

function getLocale() {
  return getRegion() === "us" ? "en_US" : "en_GB";
}

function apiBase() {
  return `https://${getRegion()}.api.blizzard.com`;
}

function signState(payload) {
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const secret = process.env.BLIZZARD_CLIENT_SECRET;

  if (!secret) {
    throw new Error("Battle.net OAuth configuration is missing");
  }

  const signature = crypto.createHmac("sha256", secret).update(body).digest("base64url");
  return `${body}.${signature}`;
}

function readState(state) {
  const [body, signature] = String(state || "").split(".");

  if (!body || !signature) {
    throw new Error("Battle.net login state was invalid");
  }

  const expected = crypto.createHmac("sha256", process.env.BLIZZARD_CLIENT_SECRET).update(body).digest("base64url");
  const actual = Buffer.from(signature);
  const wanted = Buffer.from(expected);

  if (actual.length !== wanted.length || !crypto.timingSafeEqual(actual, wanted)) {
    throw new Error("Battle.net login state was invalid");
  }

  return JSON.parse(Buffer.from(body, "base64url").toString());
}

function getBattleNetAuthorizationUrl(statePayload, redirectUri) {
  const clientId = process.env.BLIZZARD_CLIENT_ID;
  const resolvedRedirectUri = getRedirectUri(redirectUri);

  if (!clientId || !process.env.BLIZZARD_CLIENT_SECRET) {
    throw new Error("Battle.net OAuth configuration is missing");
  }

  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: resolvedRedirectUri,
    response_type: "code",
    scope: "wow.profile",
    state: signState(statePayload),
  });

  return `https://oauth.battle.net/authorize?${params.toString()}`;
}

async function requestToken(body) {
  const clientId = process.env.BLIZZARD_CLIENT_ID;
  const clientSecret = process.env.BLIZZARD_CLIENT_SECRET;

  const credentials = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");
  const response = await axios.post(
    "https://oauth.battle.net/token",
    new URLSearchParams(body),
    {
      headers: {
        Authorization: `Basic ${credentials}`,
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
      },
    },
  );

  return response.data;
}

async function exchangeCodeForTokens(code, redirectUri) {
  return requestToken({
    grant_type: "authorization_code",
    code,
    redirect_uri: getRedirectUri(redirectUri),
  });
}

async function refreshBattleNetTokens(refreshToken) {
  return requestToken({
    grant_type: "refresh_token",
    refresh_token: refreshToken,
  });
}

async function fetchBattleNetProfile(accessToken) {
  const response = await axios.get("https://oauth.battle.net/userinfo", {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: "application/json",
    },
  });

  return {
    id: String(response.data.id || response.data.sub || ""),
    battletag: response.data.battletag || "",
  };
}

function blizzardHeaders(accessToken) {
  return {
    Authorization: `Bearer ${accessToken}`,
    Accept: "application/json",
    "Battlenet-Namespace": getNamespace(),
  };
}

const { roleFromSpec } = require("./wowSpecs");

function classNameFrom(character) {
  return character.playable_class?.name
    || CLASS_NAMES[character.playable_class?.id]
    || "Unknown";
}

function specFromSpecializations(data) {
  if (!data || typeof data !== "object") return "";

  const named = data.active_specialization?.name || data.active_spec?.name || "";
  const trees = [
    ...(data.specializations || []),
    ...(data.specialization_groups || []).flatMap((group) => group.specializations || []),
  ];

  let best = { name: named, points: named ? 0 : -1 };

  for (const tree of trees) {
    const name = tree.specialization_name || tree.talent_tree?.name || tree.name || "";
    const points = Number(tree.spent_points ?? tree.points ?? 0);
    if (name && points > best.points) best = { name, points };
  }

  return best.name || "";
}

async function fetchTalentSpec(accessToken, realm, name) {
  const slug = String(realm || "").toLowerCase();
  const characterName = encodeURIComponent(String(name || "").toLowerCase());
  const params = { namespace: getNamespace(), locale: getLocale() };

  try {
    const response = await axios.get(
      `${apiBase()}/profile/wow/character/${slug}/${characterName}/specializations`,
      { headers: blizzardHeaders(accessToken), params },
    );
    return specFromSpecializations(response.data);
  } catch {
    return "";
  }
}

function armoryUrl(realm, name) {
  if (!realm || !name) {
    return null;
  }

  const region = getRegion();
  const realmSlug = String(realm).toLowerCase().replace(/\s+/g, "-");
  const characterName = encodeURIComponent(String(name).toLowerCase());

  return `https://classic-armory.org/character/${region}/tbc-anniversary/${realmSlug}/${characterName}`;
}

async function fetchCharacterDetails(accessToken, realm, name) {
  const slug = String(realm || "").toLowerCase();
  const characterName = encodeURIComponent(String(name || "").toLowerCase());
  const params = { namespace: getNamespace(), locale: getLocale() };

  try {
    const response = await axios.get(
      `${apiBase()}/profile/wow/character/${slug}/${characterName}`,
      { headers: blizzardHeaders(accessToken), params },
    );

    const talentSpec = await fetchTalentSpec(accessToken, realm, name);
    const spec = talentSpec || response.data.active_spec?.name || "";
    return {
      spec,
      role: roleFromSpec(spec),
      itemLevel: response.data.equipped_item_level || response.data.average_item_level || null,
      level: response.data.level || null,
    };
  } catch {
    return { spec: "", role: "DPS", itemLevel: null, level: null };
  }
}

async function fetchWowCharacters(accessToken) {
  const params = { namespace: getNamespace(), locale: getLocale() };
  let accounts = [];

  try {
    const response = await axios.get(`${apiBase()}/profile/user/wow`, {
      headers: blizzardHeaders(accessToken),
      params,
    });
    accounts = response.data.wow_accounts || [];
  } catch (error) {
    if (error.response?.status !== 404) {
      throw error;
    }
  }

  const rawCharacters = accounts.flatMap((account) => account.characters || []);
  const characters = [];

  for (const character of rawCharacters.slice(0, 20)) {
    const realm = character.realm?.slug || character.realm?.name || "";
    const name = character.name;
    const details = await fetchCharacterDetails(accessToken, realm, name);
    const className = classNameFrom(character);

    characters.push({
      battlenetCharacterId: String(character.id || `${realm}-${name}`),
      name,
      realm,
      region: getRegion(),
      className,
      spec: details.spec,
      role: details.role,
      itemLevel: details.itemLevel,
      level: details.level || character.level || null,
      armoryUrl: armoryUrl(realm, name),
    });
  }

  return characters;
}

module.exports = {
  getBattleNetAuthorizationUrl,
  exchangeCodeForTokens,
  refreshBattleNetTokens,
  fetchBattleNetProfile,
  fetchWowCharacters,
  readState,
  getRedirectUri,
};

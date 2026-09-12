const axios = require("axios");

const discordClient = axios.create({
  baseURL: "https://discord.com/api",
  headers: {
    Accept: "application/json",
  },
});

function getDiscordAuthorizationUrl(state = "/", redirectUri) {
  const clientId = process.env.DISCORD_CLIENT_ID;
  const resolvedRedirectUri = redirectUri || process.env.DISCORD_REDIRECT_URI;

  if (!clientId || !resolvedRedirectUri) {
    throw new Error("Discord OAuth configuration is missing");
  }

  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: resolvedRedirectUri,
    response_type: "code",
    scope: "identify",
    state,
  });

  return `https://discord.com/oauth2/authorize?${params.toString()}`;
}

async function exchangeCodeForUser(code, redirectUri) {
  const clientId = process.env.DISCORD_CLIENT_ID;
  const clientSecret = process.env.DISCORD_CLIENT_SECRET;
  const resolvedRedirectUri = redirectUri || process.env.DISCORD_REDIRECT_URI;

  if (!clientId || !clientSecret || !resolvedRedirectUri) {
    throw new Error("Discord OAuth configuration is missing");
  }

  const tokenResponse = await discordClient.post(
    "/oauth2/token",
    new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      grant_type: "authorization_code",
      code,
      redirect_uri: resolvedRedirectUri,
    }),
    {
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
      },
    },
  );

  const userResponse = await discordClient.get("/users/@me", {
    headers: {
      Authorization: `Bearer ${tokenResponse.data.access_token}`,
    },
  });

  return {
    profile: userResponse.data,
    tokens: {
      access_token: tokenResponse.data.access_token,
      refresh_token: tokenResponse.data.refresh_token,
      expires_in: tokenResponse.data.expires_in,
    },
  };
}

module.exports = { exchangeCodeForUser, getDiscordAuthorizationUrl };

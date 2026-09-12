const axios = require("axios");

const discordClient = axios.create({
  baseURL: "https://discord.com/api",
  timeout: 8000, // 8-second safety timeout so requests never hang infinitely
  headers: {
    Accept: "application/json",
  },
});

function getDiscordAuthorizationUrl() {
  const clientId = process.env.DISCORD_CLIENT_ID;
  const redirectUri = process.env.DISCORD_REDIRECT_URI;

  if (!clientId || !redirectUri) {
    throw new Error("Discord OAuth configuration is missing");
  }

  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: "identify",
  });

  return `https://discord.com/oauth2/authorize?${params.toString()}`;
}

async function exchangeCodeForUser(code) {
  const clientId = process.env.DISCORD_CLIENT_ID;
  const clientSecret = process.env.DISCORD_CLIENT_SECRET;
  const redirectUri = process.env.DISCORD_REDIRECT_URI;

  if (!clientId || !clientSecret || !redirectUri) {
    throw new Error("Discord OAuth configuration is missing");
  }

  try {
    const tokenResponse = await discordClient.post(
      "/oauth2/token",
      new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        grant_type: "authorization_code",
        code,
        redirect_uri: redirectUri,
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

    return userResponse.data;
  } catch (error) {
    console.error("Discord API Request Failed:", {
      message: error.message,
      response: error.response?.data,
      status: error.response?.status,
    });
    throw error;
  }
}

module.exports = { exchangeCodeForUser, getDiscordAuthorizationUrl };

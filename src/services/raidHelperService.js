const axios = require("axios");

const raidHelperClient = axios.create({
  baseURL: "https://raid-helper.xyz/api/v4",
  headers: {
    Accept: "application/json",
  },
});

async function getServerEvents() {
  const serverId = process.env.RAID_HELPER_SERVER_ID;
  const apiKey = process.env.RAID_HELPER_API_KEY;

  if (!serverId || !apiKey) {
    const error = new Error("Raid Helper server configuration is missing");
    error.statusCode = 500;
    throw error;
  }

  const response = await raidHelperClient.get(`/servers/${serverId}/events`, {
    params: {
      IncludeSignUps: true,
    },
    headers: {
      Authorization: apiKey,
    },
  });

  return response.data;
}

module.exports = { getServerEvents };

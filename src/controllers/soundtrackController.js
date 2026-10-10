const { Router } = require("express");
const { listSoundtrackTracks } = require("../services/s3Service");

const soundtrackRouter = Router();

soundtrackRouter.get("/soundtracks", async (_req, res) => {
  try {
    const tracks = await listSoundtrackTracks();
    return res.status(200).json({ tracks });
  } catch (error) {
    console.error("Soundtrack list could not be loaded:", error.message);
    return res.status(500).json({ reason: "Soundtracks could not be loaded." });
  }
});

module.exports = soundtrackRouter;

const { Router } = require("express");
const { getServerEvents, getEventById, signUpForEvent, deleteEvent, createEvent, isGenericRaidHelperEvent } = require("../services/raidHelperService");
const { findUserByDiscordId } = require("../services/userService");
const { getCharacterForUser } = require("../services/characterService");
const { canManageRaidEvents } = require("../services/discordGuildService");
const { resolveSpecForClass, roleFromSpec } = require("../services/wowSpecs");

const raidHelperRouter = Router();

function readDiscordId(req, res) {
  const discordId = String(req.body?.discordId || req.query.discordId || "").trim();
  if (!discordId) {
    res.status(400).json({ reason: "A Discord account is required.", status: "failed" });
    return "";
  }
  return discordId;
}

function handleRaidHelperError(res, error, fallback) {
  const statusCode = error.statusCode || error.response?.status || 500;
  if (statusCode >= 500) {
    console.error(fallback, error.message);
  }
  return res.status(statusCode).json({
    reason: statusCode >= 500 ? fallback : error.message,
    status: "failed",
  });
}

raidHelperRouter.get("/raid-helper/events", async (req, res) => {
  try {
    const response = await getServerEvents();
    return res.status(200).json(response.postedEvents ?? []);
  } catch (error) {
    return handleRaidHelperError(res, error, "Raid Helper events could not be loaded.");
  }
});

raidHelperRouter.post("/raid-helper/events/:eventId/signups", async (req, res) => {
  const discordId = readDiscordId(req, res);
  if (!discordId) return;

  const eventId = String(req.params.eventId || "").trim();
  if (!eventId) {
    return res.status(400).json({ reason: "A raid event is required.", status: "failed" });
  }

  const statusValue = String(req.body?.status || "primary").trim().toLowerCase();
  const status = statusValue === "tentative" || statusValue === "absence" ? statusValue : "primary";
  const characterId = String(req.body?.characterId || "").trim();

  try {
    const user = await findUserByDiscordId(discordId);
    if (!user) {
      return res.status(401).json({ reason: "Sign in with Discord first.", status: "failed" });
    }

    const event = await getEventById(eventId);
    const generic = isGenericRaidHelperEvent(event);

    if (!generic && !user.battlenet_id) {
      return res.status(403).json({ reason: "Connect your Battle.net account first.", status: "failed" });
    }

    let character = null;
    if (status === "primary" && !generic) {
      if (!characterId) {
        return res.status(400).json({ reason: "Choose a character to sign up with.", status: "failed" });
      }
      character = await getCharacterForUser(user.id, characterId);
      if (!character) {
        return res.status(400).json({ reason: "That character was not found on this Battle.net account.", status: "failed" });
      }
      const spec = resolveSpecForClass(character.class, req.body?.spec) || character.spec;
      character = {
        ...character,
        spec,
        role: roleFromSpec(spec) || character.role,
      };
    }

    await signUpForEvent({
      eventId,
      event,
      userId: discordId,
      character,
      status,
      displayName: user.global_name || user.username || req.body?.globalName || req.body?.username,
    });

    return res.status(200).json({ status: "signed" });
  } catch (error) {
    return handleRaidHelperError(res, error, "The raid sign-up could not be updated.");
  }
});

raidHelperRouter.get("/raid-helper/permissions", async (req, res) => {
  const discordId = readDiscordId(req, res);
  if (!discordId) return;

  try {
    const user = await findUserByDiscordId(discordId);
    const canDeleteEvents = await canManageRaidEvents({
      discordId,
      username: req.query.username || user?.username,
      globalName: req.query.globalName || user?.global_name,
    });
    return res.status(200).json({
      canDeleteEvents,
      canCreateEvents: canDeleteEvents,
    });
  } catch (error) {
    return handleRaidHelperError(res, error, "Raid permissions could not be loaded.");
  }
});

raidHelperRouter.post("/raid-helper/events", async (req, res) => {
  const discordId = readDiscordId(req, res);
  if (!discordId) return;

  try {
    const user = await findUserByDiscordId(discordId);
    const allowed = await canManageRaidEvents({
      discordId,
      username: req.body?.username || user?.username,
      globalName: req.body?.globalName || user?.global_name,
    });

    if (!allowed) {
      return res.status(403).json({ reason: "Only Discord GMs can create raid events.", status: "failed" });
    }

    const event = await createEvent({
      title: req.body?.title,
      description: req.body?.description,
      date: req.body?.date,
      time: req.body?.time,
      raid: req.body?.raid,
      leaderId: discordId,
      duration: req.body?.duration,
      limit: req.body?.limit,
      image: req.body?.image,
    });

    return res.status(201).json({ status: "created", event });
  } catch (error) {
    return handleRaidHelperError(res, error, "The raid event could not be created.");
  }
});

raidHelperRouter.delete("/raid-helper/events/:eventId", async (req, res) => {
  const discordId = readDiscordId(req, res);
  if (!discordId) return;

  const eventId = String(req.params.eventId || "").trim();
  if (!eventId) {
    return res.status(400).json({ reason: "A raid event is required.", status: "failed" });
  }

  try {
    const user = await findUserByDiscordId(discordId);
    const allowed = await canManageRaidEvents({
      discordId,
      username: req.body?.username || user?.username,
      globalName: req.body?.globalName || user?.global_name,
    });

    if (!allowed) {
      return res.status(403).json({ reason: "Only Discord GMs can delete raid events.", status: "failed" });
    }

    await deleteEvent(eventId);
    return res.status(200).json({ status: "deleted" });
  } catch (error) {
    return handleRaidHelperError(res, error, "The raid event could not be deleted.");
  }
});

module.exports = raidHelperRouter;

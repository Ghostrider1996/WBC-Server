const { Router } = require("express");
const { isOwner } = require("../services/adminService");
const { sessionFromRequest } = require("../services/sessionToken");
const triviaService = require("../services/triviaService");
const raidHelperService = require("../services/raidHelperService");
const quizStore = require("../services/quiz/quizStore");
const { getSharedManager } = require("../services/quiz/quizManager");
const { normalizePool, normalizeSettings, normalizeTitle, normalizeAllowedDiscordIds } = require("../services/quiz/quizSetup");

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const GENERIC_FAILURE = "The quiz could not be updated.";

function sendFailure(res, statusCode, reason, fields) {
  return res.status(statusCode).json({ reason, status: "failed", ...(fields ? { fields } : {}) });
}

function sendError(res, error) {
  const statusCode = Number.isInteger(error?.statusCode) ? error.statusCode : 500;
  if (statusCode >= 500) {
    console.error("Quiz request failed:", error?.message);
    return sendFailure(res, statusCode, GENERIC_FAILURE);
  }
  return sendFailure(res, statusCode, error.message, error.fields);
}

function publicSession(session) {
  return {
    id: session.id,
    title: session.title,
    raidHelperEventId: session.raidHelperEventId,
    status: session.status,
    hostName: session.hostName,
    createdAt: session.createdAt,
    startedAt: session.startedAt,
  };
}

function createQuizRouter(deps = {}) {
  const store = deps.store || quizStore;
  const trivia = deps.trivia || triviaService;
  const getEvent = deps.getEvent || raidHelperService.getEventById;
  const ownerCheck = deps.isOwner || isOwner;
  const readSession = deps.sessionFromRequest || sessionFromRequest;
  const cancelQuiz = deps.cancelQuiz || ((id) => getSharedManager().cancel(id));

  const router = Router();

  function requireSession(req, res, next) {
    const session = readSession(req);
    if (!session) return sendFailure(res, 401, "Sign in with Discord to use the quiz.");
    req.quizSession = session;
    return next();
  }

  async function isHostUser(discordId) {
    return Boolean(ownerCheck({ discordId })) || trivia.isTriviaAdmin(discordId);
  }

  async function requireHost(req, res, next) {
    try {
      if (!await isHostUser(req.quizSession.discordId)) {
        return sendFailure(res, 403, "Only trivia admins can host a quiz.");
      }
      return next();
    } catch (error) {
      return sendError(res, error);
    }
  }

  function handle(work, successStatus = 200) {
    return async (req, res) => {
      try {
        return res.status(successStatus).json(await work(req));
      } catch (error) {
        return sendError(res, error);
      }
    };
  }

  router.param("id", (req, res, next, id) => {
    if (!UUID_PATTERN.test(id)) return sendFailure(res, 404, "Quiz not found.");
    return next();
  });

  // Public so Home / Raids cards can show Join without a session. Joining the room still requires Discord.
  router.get("/quiz/sessions/active", handle(async () => {
    const sessions = await store.listOpenSessions();
    return { sessions: sessions.map(publicSession) };
  }));

  router.use("/quiz", requireSession);

  router.get("/quiz/types", requireHost, handle(async () => ({
    types: await store.readyTypeCounts(),
  })));

  router.get("/quiz/categories", requireHost, handle(async () => ({
    categories: await store.readyCategoryCounts(),
  })));

  router.post("/quiz/sessions", requireHost, handle(async (req) => {
    const body = req.body || {};
    const skipEvent = body.skipRaidHelperEvent === true;
    const eventId = skipEvent
      ? ""
      : (typeof body.raidHelperEventId === "string" ? body.raidHelperEventId.trim() : "");
    if (!eventId && !skipEvent) {
      const error = new Error("Choose the event this quiz is for.");
      error.statusCode = 400;
      error.fields = { raidHelperEventId: "Choose the event this quiz is for." };
      throw error;
    }

    const event = eventId ? await getEvent(eventId) : null;
    const allowedDiscordIds = skipEvent ? normalizeAllowedDiscordIds(body.allowedDiscordIds) : null;
    const types = await store.readyTypeCounts();
    const available = new Map(types.map((item) => [item.type, item.count]));

    const session = await store.createSession({
      title: normalizeTitle(body.title, event?.title ?? event?.name),
      raidHelperEventId: eventId || null,
      allowedDiscordIds,
      hostDiscordId: req.quizSession.discordId,
      rounds: normalizePool(body, available),
      settings: normalizeSettings(body.settings),
    });

    return { session: publicSession(session) };
  }, 201));

  router.post("/quiz/sessions/:id/cancel", requireHost, handle(async (req) => {
    const session = await store.getSession(req.params.id);
    if (!session) {
      const error = new Error("Quiz not found.");
      error.statusCode = 404;
      throw error;
    }
    await cancelQuiz(req.params.id);
    return { ok: true };
  }));

  router.get("/quiz/sessions/:id/results", handle(async (req) => {
    const { discordId } = req.quizSession;
    const allowed = await isHostUser(discordId) || await store.wasPlayer(req.params.id, discordId);
    const results = allowed ? await store.getResults(req.params.id) : null;
    if (!results) {
      const error = new Error("Quiz not found.");
      error.statusCode = 404;
      throw error;
    }
    return { session: publicSession(results.session), players: results.players };
  }));

  return router;
}

const quizRouter = createQuizRouter();

module.exports = quizRouter;
module.exports.createQuizRouter = createQuizRouter;

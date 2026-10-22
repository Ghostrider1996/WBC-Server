const { Router } = require("express");
const { isOwner } = require("../services/adminService");
const { sessionFromRequest } = require("../services/sessionToken");
const triviaService = require("../services/triviaService");
const s3Service = require("../services/s3Service");
const { handleTriviaMediaUpload, limitMessage } = require("../middleware/triviaUpload");
const {
  TRIVIA_MEDIA_KINDS,
  TRIVIA_MEDIA_LIMITS,
  isTriviaKey,
  sniffTriviaMime,
} = require("../services/triviaMedia");
const { validateQuestionInput } = require("../services/triviaValidation");

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const GENERIC_FAILURE = "The trivia question bank could not be updated.";

function sendFailure(res, statusCode, reason, fields) {
  return res.status(statusCode).json({ reason, status: "failed", ...(fields ? { fields } : {}) });
}

function sendError(res, error) {
  const statusCode = Number.isInteger(error?.statusCode) ? error.statusCode : 500;
  if (statusCode >= 500) {
    console.error("Trivia request failed:", error?.message);
    return sendFailure(res, statusCode, GENERIC_FAILURE);
  }
  return sendFailure(res, statusCode, error.message, error.fields);
}

function createTriviaRouter(deps = {}) {
  const service = deps.service || triviaService;
  const s3 = deps.s3 || s3Service;
  const ownerCheck = deps.isOwner || isOwner;
  const readSession = deps.sessionFromRequest || sessionFromRequest;
  const uploadMiddleware = deps.uploadMiddleware || handleTriviaMediaUpload;

  const router = Router();

  function requireSession(req, res, next) {
    const session = readSession(req);
    if (!session) {
      return sendFailure(res, 401, "Sign in again to use the trivia question bank.");
    }
    req.triviaSession = session;
    return next();
  }

  function requireOwner(req, res, next) {
    if (!ownerCheck({ discordId: req.triviaSession.discordId })) {
      return sendFailure(res, 403, "Only the guild owner can manage trivia admins.");
    }
    return next();
  }

  async function requireTriviaAdmin(req, res, next) {
    try {
      const { discordId } = req.triviaSession;
      if (!ownerCheck({ discordId }) && !await service.isTriviaAdmin(discordId)) {
        return sendFailure(res, 403, "You do not have access to the trivia question bank.");
      }
      return next();
    } catch (error) {
      return sendError(res, error);
    }
  }

  function handle(work, successStatus = 200) {
    return async (req, res) => {
      try {
        const data = await work(req, res);
        if (res.headersSent) return undefined;
        return res.status(successStatus).json(data);
      } catch (error) {
        return sendError(res, error);
      }
    };
  }

  function notFound(res, message = "Question not found.") {
    return sendFailure(res, 404, message);
  }

  router.use("/trivia", requireSession);

  router.param("id", (req, res, next, id) => {
    if (!UUID_PATTERN.test(id)) return notFound(res);
    return next();
  });

  router.get("/trivia/access", handle(async (req) => {
    const discordId = req.triviaSession.discordId;
    const owner = Boolean(ownerCheck({ discordId }));
    return {
      isTriviaAdmin: owner || await service.isTriviaAdmin(discordId),
      isOwner: owner,
    };
  }));

  router.get("/trivia/admins", requireOwner, handle(() => service.listTriviaAdmins()));
  router.post("/trivia/admins", requireOwner, handle(
    (req) => service.addTriviaAdmin(req.body?.discordId, req.triviaSession.discordId),
    201,
  ));
  router.delete("/trivia/admins/:discordId", requireOwner, handle(
    (req) => service.removeTriviaAdmin(req.params.discordId),
  ));

  router.get("/trivia/questions", requireTriviaAdmin, handle((req) => service.listQuestions(req.query)));

  router.get("/trivia/questions/:id", requireTriviaAdmin, handle(async (req, res) => {
    const question = await service.getQuestion(req.params.id);
    if (!question) return notFound(res);
    return question;
  }));

  function readQuestionBody(req) {
    const { value, fields } = validateQuestionInput(req.body);
    if (!value) {
      const error = new Error("Fix the highlighted fields and try again.");
      error.statusCode = 400;
      error.fields = fields;
      throw error;
    }
    return value;
  }

  router.post("/trivia/questions", requireTriviaAdmin, handle(
    (req) => service.createQuestion(readQuestionBody(req), req.triviaSession.discordId),
    201,
  ));

  router.put("/trivia/questions/:id", requireTriviaAdmin, handle(async (req, res) => {
    const value = readQuestionBody(req);
    const question = await service.replaceQuestion(req.params.id, value);
    if (!question) return notFound(res);
    return question;
  }));

  router.delete("/trivia/questions/:id", requireTriviaAdmin, handle(async (req, res) => {
    if (!await service.deleteQuestion(req.params.id)) return notFound(res);
    return { status: "deleted" };
  }));

  router.post("/trivia/questions/:id/duplicate", requireTriviaAdmin, handle(async (req, res) => {
    const question = await service.duplicateQuestion(req.params.id, req.triviaSession.discordId);
    if (!question) return notFound(res);
    return question;
  }, 201));

  router.get("/trivia/categories", requireTriviaAdmin, handle(() => service.listCategories()));

  router.post("/trivia/media", requireTriviaAdmin, uploadMiddleware, handle(async (req, res) => {
    const kind = typeof req.body?.kind === "string" ? req.body.kind : "";
    if (!TRIVIA_MEDIA_KINDS.includes(kind)) {
      return sendFailure(res, 400, "kind must be image, audio, or video.", { kind: "Must be one of: image, audio, video." });
    }

    const file = req.file;
    if (!file?.buffer || file.size === 0) {
      return sendFailure(res, 400, "A file is required.", { file: "Required." });
    }

    if (file.size > TRIVIA_MEDIA_LIMITS[kind]) {
      return sendFailure(res, 413, limitMessage(kind), { file: limitMessage(kind) });
    }

    const mimeType = sniffTriviaMime(file.buffer, kind);
    if (!mimeType) {
      const message = `That file is not a supported ${kind} format.`;
      return sendFailure(res, 415, message, { file: message });
    }

    const uploaded = await s3.uploadTriviaMedia({ kind, buffer: file.buffer, mimeType });
    return {
      key: uploaded.key,
      kind,
      mimeType: uploaded.mimeType,
      size: uploaded.size,
      url: uploaded.url,
      expiresAt: uploaded.expiresAt,
    };
  }, 201));

  router.delete("/trivia/media", requireTriviaAdmin, handle(async (req, res) => {
    const key = req.body?.key;
    if (!isTriviaKey(key)) {
      return sendFailure(res, 400, "A valid media key is required.", { key: "Must look like trivia/<name>." });
    }
    await service.removeUnreferencedMedia(key);
    return { status: "deleted" };
  }));

  return router;
}

function triviaErrorHandler(error, _req, res, next) {
  if (res.headersSent) return next(error);

  if (error?.type === "entity.parse.failed") {
    return sendFailure(res, 400, "The request body is not valid JSON.");
  }
  if (error?.type === "entity.too.large") {
    return sendFailure(res, 413, "The request body is too large.");
  }

  const statusCode = Number.isInteger(error?.statusCode) && error.statusCode < 500 ? error.statusCode : 500;
  if (statusCode >= 500) console.error("Trivia request failed:", error?.message);
  return sendFailure(res, statusCode, statusCode >= 500 ? GENERIC_FAILURE : error.message);
}

const triviaRouter = createTriviaRouter();

module.exports = triviaRouter;
module.exports.createTriviaRouter = createTriviaRouter;
module.exports.triviaErrorHandler = triviaErrorHandler;

const multer = require("multer");
const {
  TRIVIA_MAX_UPLOAD_BYTES,
  TRIVIA_MEDIA_KINDS,
  TRIVIA_MEDIA_LIMITS,
} = require("../services/triviaMedia");

// Multipart overhead (boundaries, the kind field) on top of the largest allowed file.
const MAX_REQUEST_BYTES = TRIVIA_MAX_UPLOAD_BYTES + 512 * 1024;

function limitMessage(kind) {
  const megabytes = Math.round((TRIVIA_MEDIA_LIMITS[kind] || TRIVIA_MAX_UPLOAD_BYTES) / (1024 * 1024));
  return `${kind[0].toUpperCase()}${kind.slice(1)} files must be ${megabytes}MB or smaller.`;
}

function tooLarge(kind) {
  return Object.assign(new Error(limitMessage(kind)), { statusCode: 413, fields: { file: limitMessage(kind) } });
}

/**
 * Buffers one uploaded file in memory but stops as soon as it exceeds the limit
 * for its kind. `kind` is enforced while streaming when the client sent it before
 * the file part; otherwise the global maximum applies here and the per-kind limit
 * is checked right after parsing.
 */
function kindLimitedMemoryStorage() {
  return {
    _handleFile(req, file, callback) {
      const kind = typeof req.body?.kind === "string" ? req.body.kind : "";
      const limitKind = TRIVIA_MEDIA_KINDS.includes(kind) ? kind : "video";
      const limit = TRIVIA_MEDIA_LIMITS[limitKind];
      const chunks = [];
      let size = 0;
      let finished = false;

      file.stream.on("data", (chunk) => {
        if (finished) return;
        size += chunk.length;
        if (size > limit) {
          finished = true;
          chunks.length = 0;
          callback(tooLarge(limitKind));
          return;
        }
        chunks.push(chunk);
      });
      file.stream.on("end", () => {
        if (finished) return;
        finished = true;
        callback(null, { buffer: Buffer.concat(chunks, size), size });
      });
      file.stream.on("error", (error) => {
        if (finished) return;
        finished = true;
        callback(error);
      });
    },
    _removeFile(_req, file, callback) {
      delete file.buffer;
      callback(null);
    },
  };
}

const upload = multer({
  storage: kindLimitedMemoryStorage(),
  limits: { fileSize: TRIVIA_MAX_UPLOAD_BYTES, files: 1, fields: 5, parts: 8 },
});

function sendFailure(res, status, reason, fields) {
  return res.status(status).json({ reason, status: "failed", ...(fields ? { fields } : {}) });
}

function handleTriviaMediaUpload(req, res, next) {
  const declaredLength = Number.parseInt(req.headers["content-length"], 10);
  if (Number.isFinite(declaredLength) && declaredLength > MAX_REQUEST_BYTES) {
    res.setHeader("Connection", "close");
    return sendFailure(res, 413, limitMessage("video"), { file: limitMessage("video") });
  }

  upload.single("file")(req, res, (error) => {
    if (!error) return next();

    if (error.statusCode === 413 || error.code === "LIMIT_FILE_SIZE") {
      const message = error.statusCode === 413 ? error.message : limitMessage("video");
      return sendFailure(res, 413, message, { file: message });
    }
    if (error instanceof multer.MulterError) {
      return sendFailure(res, 400, "The upload was not valid. Send one file in the \"file\" field.", { file: "Send exactly one file." });
    }
    if (/multipart|boundary|Unexpected end of form/i.test(String(error.message))) {
      return sendFailure(res, 400, "The upload was not valid multipart form data.");
    }

    console.error("Trivia media upload failed:", error.message);
    return sendFailure(res, 500, "The media could not be uploaded.");
  });
}

module.exports = { MAX_REQUEST_BYTES, handleTriviaMediaUpload, limitMessage };

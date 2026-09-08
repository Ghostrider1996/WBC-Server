function cors() {
  const allowedOrigins = [
    "http://localhost:5173",
    process.env.WBC_WEB_ORIGIN
  ];

  return function (req, res, next) {
    const origin = req.headers.origin;

    const isLocalDevelopmentOrigin = /^http:\/\/localhost:\d+$/.test(origin || "");

    if (origin && (allowedOrigins.includes(origin) || isLocalDevelopmentOrigin)) {
      res.setHeader("Access-Control-Allow-Origin", origin);
    }

    res.setHeader("Access-Control-Allow-Methods", "OPTIONS, GET");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");

    if (req.method === "OPTIONS") {
      res.status(204).end(); // Properly end response
      return;
    }

    next();
  };
}

module.exports = { cors };
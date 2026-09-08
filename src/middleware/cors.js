function cors() {
  const configuredOrigins = (process.env.WBC_WEB_ORIGIN || "")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);

  const allowedOrigins = [
    "http://localhost:5173",
    "http://localhost:5174",
    "http://127.0.0.1:5173",
    "http://127.0.0.1:5174",
    "https://ghostrider1996.github.io",
    ...configuredOrigins,
  ];

  const isAllowedOrigin = (origin) => {
    if (!origin) return false;

    if (allowedOrigins.includes(origin)) return true;

    return /^https:\/\/([a-z0-9-]+\.)*github\.io$/i.test(origin)
      || /^https:\/\/([a-z0-9-]+\.)*vercel\.app$/i.test(origin)
      || /^https:\/\/([a-z0-9-]+\.)*render\.com$/i.test(origin)
      || /^http:\/\/localhost:\d+$/i.test(origin);
  };

  return function (req, res, next) {
    const origin = req.headers.origin;

    if (origin && isAllowedOrigin(origin)) {
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Vary", "Origin");
    }

    res.setHeader("Access-Control-Allow-Methods", "OPTIONS, GET, POST, PUT, PATCH, DELETE");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, Accept");
    res.setHeader("Access-Control-Allow-Credentials", "true");

    if (req.method === "OPTIONS") {
      res.status(204).end();
      return;
    }

    next();
  };
}

module.exports = { cors };
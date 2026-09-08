const dotenv = require("dotenv");
const express = require("express");
const path = require('path');
const { configRoutes } = require("./config/configRouter");
const { configExpress } = require("./config/configExpress");

dotenv.config({ path: path.resolve(__dirname, "../../.env") });

const PORT = process.env.PORT || 3030;
const app = express();

configExpress(app);
configRoutes(app);

app.listen(PORT, () => {
  console.log(`Guild backend running on http://localhost:${PORT}`);
});

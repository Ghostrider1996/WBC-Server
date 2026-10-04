const express = require("express");
const { cors } = require("../middleware/cors");

function configExpress(app) {
  app.use(cors());
  app.use(express.json({ limit: "2mb" }));
  app.use(express.urlencoded({ extended: true }));
}
module.exports = { configExpress };


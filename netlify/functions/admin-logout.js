"use strict";

const { json, options } = require("./lib/http");
const { clearSessionCookie } = require("./lib/auth");

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return options();
  return json(200, { ok: true }, { "Set-Cookie": clearSessionCookie() });
};

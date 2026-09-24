"use strict";

const { json, options, parseBody } = require("./lib/http");
const {
  authenticateUser,
  createSessionCookie,
  getSession,
  adminConfigured,
} = require("./lib/auth");

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return options();

  if (event.httpMethod === "GET") {
    const session = getSession(event);
    return json(200, {
      ok: true,
      authenticated: !!session,
      user: session ? session.user : null,
      adminConfigured: adminConfigured(),
    });
  }

  if (event.httpMethod !== "POST") {
    return json(405, { ok: false, reason: "method_not_allowed" });
  }

  if (!adminConfigured()) {
    return json(503, {
      ok: false,
      reason: "admin_not_configured",
      message:
        "Set ADMIN_DAN_PASSWORD and ADMIN_ZAC_PASSWORD in Netlify environment variables.",
    });
  }

  const body = parseBody(event);
  const username = body.username || body.user || "";
  const password = body.password || "";

  const user = authenticateUser(username, password);
  if (!user) {
    return json(401, { ok: false, reason: "invalid_credentials" });
  }

  return json(
    200,
    { ok: true, user },
    { "Set-Cookie": createSessionCookie(user) }
  );
};

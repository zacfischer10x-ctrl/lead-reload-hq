"use strict";

/**
 * GET /.netlify/functions/admin-me
 * Who am I? Used by /admin/ after Identity sign-in.
 * 401 no Identity user, 403 not an allowlisted admin, 200 { ok, email }.
 * Replaces the retired username/password + session-cookie login functions.
 */
const { json, options, ADMIN_NO_STORE } = require("./lib/http");
const { requireAdmin } = require("./lib/auth");

exports.handler = async (event, context) => {
  if (event.httpMethod === "OPTIONS") return options();
  if (event.httpMethod !== "GET") {
    return json(405, { ok: false, reason: "method_not_allowed" }, ADMIN_NO_STORE);
  }
  const auth = requireAdmin(event, context);
  if (!auth.ok) {
    return json(auth.statusCode, { ok: false, reason: auth.error }, ADMIN_NO_STORE);
  }
  return json(200, { ok: true, email: auth.user.email }, ADMIN_NO_STORE);
};

"use strict";

const { json, options, ADMIN_NO_STORE } = require("./lib/http");
const { requireAdmin } = require("./lib/auth");
const { ordersStore, listJson } = require("./lib/blobs");

exports.handler = async (event, context) => {
  if (event.httpMethod === "OPTIONS") return options();
  if (event.httpMethod !== "GET") {
    return json(405, { ok: false, reason: "method_not_allowed" }, ADMIN_NO_STORE);
  }
  // Netlify Identity: 401 no user, 403 email not in ADMIN_EMAILS (lib/auth.js)
  const auth = requireAdmin(event, context);
  if (!auth.ok) {
    return json(auth.statusCode, { ok: false, reason: auth.error }, ADMIN_NO_STORE);
  }

  try {
    const orders = await listJson(ordersStore(event));
    orders.sort((a, b) =>
      String(b.paidAt || "").localeCompare(String(a.paidAt || ""))
    );
    return json(200, { ok: true, orders }, ADMIN_NO_STORE);
  } catch (err) {
    console.error("admin-orders", err);
    return json(
      500,
      { ok: false, reason: "storage_error", message: err.message },
      ADMIN_NO_STORE
    );
  }
};

"use strict";

/**
 * GET /.netlify/functions/admin-orders?status=all|open|completed&type=all|one-time|subscription
 *
 * Lists fulfillable orders (admin only), newest first.
 *   status  all (default) | open (New or In progress) | completed
 *   type    all (default) | one-time | subscription (initial subscription
 *           orders AND their renewals)
 * Rows are normalized on read (lib/orders.js): rows written before
 * fulfillment tracking have fulfillmentStatus "New" (or "Completed" if the
 * legacy status was "fulfilled"). Nothing is rewritten here.
 * Response: { ok, orders, counts: { all, open, completed }, filters }
 * where counts are for the chosen type across every status.
 */
const { json, options, ADMIN_NO_STORE } = require("./lib/http");
const { requireAdmin } = require("./lib/auth");
const { ordersStore, listJson } = require("./lib/blobs");
const {
  STATUS_FILTERS,
  TYPE_FILTERS,
  normalizeOrder,
  filterOrders,
} = require("./lib/orders");

function queryParam(event, name) {
  const q = event.queryStringParameters || {};
  const v = q[name];
  if (v == null || v === "") return "all";
  return String(v).trim().toLowerCase();
}

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

  const status = queryParam(event, "status");
  const type = queryParam(event, "type");
  if (!STATUS_FILTERS.includes(status)) {
    return json(400, { ok: false, reason: "invalid_status_filter" }, ADMIN_NO_STORE);
  }
  if (!TYPE_FILTERS.includes(type)) {
    return json(400, { ok: false, reason: "invalid_type_filter" }, ADMIN_NO_STORE);
  }

  try {
    const all = (await listJson(ordersStore(event))).map(normalizeOrder);
    all.sort((a, b) =>
      String(b.paidAt || "").localeCompare(String(a.paidAt || ""))
    );
    const ofType = filterOrders(all, { type });
    const orders = filterOrders(ofType, { status });
    const completed = ofType.filter((o) => o.fulfillmentStatus === "Completed").length;
    return json(
      200,
      {
        ok: true,
        orders,
        counts: { all: ofType.length, open: ofType.length - completed, completed },
        filters: { status, type },
      },
      ADMIN_NO_STORE
    );
  } catch (err) {
    console.error("admin-orders", err);
    return json(
      500,
      { ok: false, reason: "storage_error", message: err.message },
      ADMIN_NO_STORE
    );
  }
};

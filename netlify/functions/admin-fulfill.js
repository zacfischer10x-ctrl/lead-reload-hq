"use strict";

/**
 * POST /.netlify/functions/admin-fulfill   (admin only)
 *
 * Body: { orderId, action }  action = "complete" | "start" | "reopen"
 *   or: { orderId, status }  status = "New" | "In progress" | "Completed"
 *       (legacy "open" → New and "fulfilled" → Completed are still accepted
 *       so a cached older admin page keeps working)
 *
 *   → Completed: completedAt = now, completedBy = the admin's Identity email
 *   → New / In progress from Completed: completedAt / completedBy cleared
 *   Every change sets statusUpdatedAt / statusUpdatedBy. Setting the status
 *   an order already has is a no-op (200, changed:false).
 *
 * 400 missing_order_id | invalid_order_id | invalid_action | invalid_status
 * 404 not_found. 401/403 from lib/auth.js before any storage access.
 */
const { json, options, parseBody, ADMIN_NO_STORE } = require("./lib/http");
const { requireAdmin } = require("./lib/auth");
const { ordersStore, setJson } = require("./lib/blobs");
const { ORDER_ID_RE, ACTIONS, parseStatus, applyStatus } = require("./lib/orders");

exports.handler = async (event, context) => {
  if (event.httpMethod === "OPTIONS") return options();
  if (event.httpMethod !== "POST") {
    return json(405, { ok: false, reason: "method_not_allowed" }, ADMIN_NO_STORE);
  }
  // Netlify Identity: 401 no user, 403 email not in ADMIN_EMAILS (lib/auth.js)
  const auth = requireAdmin(event, context);
  if (!auth.ok) {
    return json(auth.statusCode, { ok: false, reason: auth.error }, ADMIN_NO_STORE);
  }

  const body = parseBody(event);
  const { orderId, action, status } = body && typeof body === "object" ? body : {};
  if (orderId == null || orderId === "") {
    return json(400, { ok: false, reason: "missing_order_id" }, ADMIN_NO_STORE);
  }
  if (typeof orderId !== "string" || !ORDER_ID_RE.test(orderId)) {
    return json(400, { ok: false, reason: "invalid_order_id" }, ADMIN_NO_STORE);
  }

  let next;
  if (action != null) {
    next = typeof action === "string" && Object.prototype.hasOwnProperty.call(ACTIONS, action)
      ? ACTIONS[action]
      : null;
    if (!next) return json(400, { ok: false, reason: "invalid_action" }, ADMIN_NO_STORE);
  } else {
    next = parseStatus(status);
    if (!next) return json(400, { ok: false, reason: "invalid_status" }, ADMIN_NO_STORE);
  }

  try {
    const store = ordersStore(event);
    const existing = await store.get(orderId, { type: "json" });
    if (!existing) {
      return json(404, { ok: false, reason: "not_found" }, ADMIN_NO_STORE);
    }
    const { changed, order } = applyStatus(existing, next, auth.user.email);
    if (changed) await setJson(store, orderId, order);
    return json(200, { ok: true, changed, order }, ADMIN_NO_STORE);
  } catch (err) {
    console.error("admin-fulfill", err);
    return json(
      500,
      { ok: false, reason: "storage_error", message: err.message },
      ADMIN_NO_STORE
    );
  }
};

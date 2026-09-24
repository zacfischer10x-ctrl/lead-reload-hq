"use strict";

const { json, options, parseBody } = require("./lib/http");
const { requireAdmin } = require("./lib/auth");
const { ordersStore, setJson } = require("./lib/blobs");

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return options();
  if (event.httpMethod !== "POST") {
    return json(405, { ok: false, reason: "method_not_allowed" });
  }
  const auth = requireAdmin(event);
  if (!auth.ok) return json(auth.statusCode, { ok: false, reason: auth.error });

  const { orderId, status } = parseBody(event);
  if (!orderId) return json(400, { ok: false, reason: "missing_order_id" });
  const next = status === "open" ? "open" : "fulfilled";

  try {
    const store = ordersStore(event);
    const existing = await store.get(String(orderId), { type: "json" });
    if (!existing) return json(404, { ok: false, reason: "not_found" });
    existing.status = next;
    existing.fulfilledAt =
      next === "fulfilled" ? new Date().toISOString() : null;
    existing.updatedAt = new Date().toISOString();
    await setJson(store, String(orderId), existing);
    return json(200, { ok: true, order: existing });
  } catch (err) {
    console.error("admin-fulfill", err);
    return json(500, {
      ok: false,
      reason: "storage_error",
      message: err.message,
    });
  }
};

"use strict";

const { json, options } = require("./lib/http");
const { requireAdmin } = require("./lib/auth");
const { ordersStore, listJson } = require("./lib/blobs");

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return options();
  if (event.httpMethod !== "GET") {
    return json(405, { ok: false, reason: "method_not_allowed" });
  }
  const auth = requireAdmin(event);
  if (!auth.ok) return json(auth.statusCode, { ok: false, reason: auth.error });

  try {
    const orders = await listJson(ordersStore(event));
    orders.sort((a, b) =>
      String(b.paidAt || "").localeCompare(String(a.paidAt || ""))
    );
    return json(200, { ok: true, orders });
  } catch (err) {
    console.error("admin-orders", err);
    return json(500, {
      ok: false,
      reason: "storage_error",
      message: err.message,
    });
  }
};

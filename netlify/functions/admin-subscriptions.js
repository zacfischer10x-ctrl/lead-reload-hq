"use strict";

const { json, options } = require("./lib/http");
const { requireAdmin } = require("./lib/auth");
const { subsStore, listJson } = require("./lib/blobs");

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return options();
  if (event.httpMethod !== "GET") {
    return json(405, { ok: false, reason: "method_not_allowed" });
  }
  const auth = requireAdmin(event);
  if (!auth.ok) return json(auth.statusCode, { ok: false, reason: auth.error });

  try {
    const subscriptions = await listJson(subsStore(event));
    subscriptions.sort((a, b) =>
      String(b.updatedAt || b.paidAt || "").localeCompare(
        String(a.updatedAt || a.paidAt || "")
      )
    );
    return json(200, { ok: true, subscriptions });
  } catch (err) {
    console.error("admin-subscriptions", err);
    return json(500, {
      ok: false,
      reason: "storage_error",
      message: err.message,
    });
  }
};

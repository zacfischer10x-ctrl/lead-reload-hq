"use strict";

/**
 * Order fulfillment model shared by stripe-webhook, admin-orders and
 * admin-fulfill.
 *
 * Every row in the lr-orders blob store is one fulfillable order:
 *   kind "one-time"      checkout.session.completed, mode=payment   (key: session id)
 *   kind "subscription"  checkout.session.completed, mode=subscription
 *                        = the first paid period                    (key: session id)
 *   kind "renewal"       invoice.paid for a later subscription period (key: invoice id)
 *
 * Fulfillment fields (added 2026-09-28):
 *   fulfillmentStatus  "New" | "In progress" | "Completed"   (default New)
 *   completedAt        ISO time the order was marked Completed, else null
 *   completedBy        admin Identity email that completed it, else null
 *   statusUpdatedAt    ISO time of the last status change, else null
 *   statusUpdatedBy    admin Identity email of the last status change, else null
 *
 * Older rows have none of these (and may carry the legacy status
 * "open"/"fulfilled" + fulfilledAt). They are normalized on read only:
 * nothing is rewritten until an admin changes the status.
 */

const FULFILLMENT_STATUSES = Object.freeze(["New", "In progress", "Completed"]);
const STATUS_FILTERS = Object.freeze(["all", "open", "completed"]);
const TYPE_FILTERS = Object.freeze(["all", "one-time", "subscription"]);
const ORDER_KINDS = Object.freeze(["one-time", "subscription", "renewal"]);

// Stripe ids are [A-Za-z0-9_]; allow - and : for safety, nothing else.
const ORDER_ID_RE = /^[A-Za-z0-9_:-]{1,200}$/;

/** "complete" / "Completed" / "fulfilled" → "Completed", etc. null if unknown. */
function parseStatus(value) {
  if (typeof value !== "string") return null;
  const v = value.trim().toLowerCase().replace(/[\s_-]+/g, " ");
  if (v === "new" || v === "open") return "New";
  if (v === "in progress" || v === "inprogress") return "In progress";
  if (v === "completed" || v === "complete" || v === "fulfilled") return "Completed";
  return null;
}

/** Admin actions → target status. */
const ACTIONS = Object.freeze({
  complete: "Completed",
  start: "In progress",
  reopen: "New",
});

function orderKind(rec) {
  const k = rec && (rec.kind || rec.type);
  return ORDER_KINDS.includes(k) ? k : "one-time";
}

function fulfillmentStatusOf(rec) {
  if (rec && FULFILLMENT_STATUSES.includes(rec.fulfillmentStatus)) {
    return rec.fulfillmentStatus;
  }
  // Legacy rows: status "fulfilled" meant done; anything else is New.
  if (rec && rec.status === "fulfilled") return "Completed";
  return "New";
}

/** Read-side view of a stored row. Does not mutate the input. */
function normalizeOrder(rec) {
  const r = rec && typeof rec === "object" ? rec : {};
  const fulfillmentStatus = fulfillmentStatusOf(r);
  const completed = fulfillmentStatus === "Completed";
  return {
    ...r,
    kind: orderKind(r),
    fulfillmentStatus,
    completedAt: completed ? r.completedAt || r.fulfilledAt || null : null,
    completedBy: completed ? r.completedBy || null : null,
    statusUpdatedAt: r.statusUpdatedAt || null,
    statusUpdatedBy: r.statusUpdatedBy || null,
  };
}

function isOpen(rec) {
  return normalizeOrder(rec).fulfillmentStatus !== "Completed";
}

function matchesFilters(rec, { status = "all", type = "all" } = {}) {
  const o = normalizeOrder(rec);
  if (status === "open" && o.fulfillmentStatus === "Completed") return false;
  if (status === "completed" && o.fulfillmentStatus !== "Completed") return false;
  if (type === "one-time" && o.kind !== "one-time") return false;
  if (type === "subscription" && o.kind !== "subscription" && o.kind !== "renewal") {
    return false;
  }
  return true;
}

function filterOrders(records, filters) {
  return records.filter((r) => matchesFilters(r, filters));
}

/**
 * Apply a status change. Returns { changed, order } where order is the new
 * stored row. Moving to Completed stamps completedAt/completedBy; moving away
 * from Completed clears them. Setting the current status again is a no-op
 * (keeps the original completedAt/completedBy).
 */
function applyStatus(rec, nextStatus, adminEmail, now = new Date()) {
  if (!FULFILLMENT_STATUSES.includes(nextStatus)) {
    throw new Error("invalid_status");
  }
  const current = normalizeOrder(rec);
  if (current.fulfillmentStatus === nextStatus) {
    return { changed: false, order: current };
  }
  const iso = now.toISOString();
  const completed = nextStatus === "Completed";
  const order = {
    ...current,
    fulfillmentStatus: nextStatus,
    completedAt: completed ? iso : null,
    completedBy: completed ? adminEmail : null,
    statusUpdatedAt: iso,
    statusUpdatedBy: adminEmail,
    // legacy mirrors
    status: completed ? "fulfilled" : "open",
    fulfilledAt: completed ? iso : null,
    updatedAt: iso,
  };
  return { changed: true, order };
}

/** Defaults for a brand-new row written by the webhook. */
function newOrderFulfillment() {
  return {
    status: "open",
    fulfillmentStatus: "New",
    completedAt: null,
    completedBy: null,
    statusUpdatedAt: null,
    statusUpdatedBy: null,
  };
}

/**
 * Idempotent write for webhook-created rows. Stripe retries (and duplicate
 * deliveries) hit the same key, so a row is never duplicated; if it already
 * exists, the Stripe fields are refreshed but the admin's fulfillment state
 * and the original createdAt are kept.
 */
async function upsertOrder(store, key, fresh, setJson) {
  const existing = await store.get(key, { type: "json" });
  if (!existing) {
    const now = new Date().toISOString();
    const row = { ...newOrderFulfillment(), createdAt: now, ...fresh };
    await setJson(store, key, row);
    return { created: true, order: row };
  }
  // Keep the admin's fulfillment state (legacy rows are normalized first,
  // so a legacy status "fulfilled" stays Completed).
  const n = normalizeOrder(existing);
  const completed = n.fulfillmentStatus === "Completed";
  const keep = {
    fulfillmentStatus: n.fulfillmentStatus,
    completedAt: n.completedAt,
    completedBy: n.completedBy,
    statusUpdatedAt: n.statusUpdatedAt,
    statusUpdatedBy: n.statusUpdatedBy,
    status: completed ? "fulfilled" : "open",
    fulfilledAt: completed ? n.completedAt : null,
  };
  const row = {
    ...existing,
    ...fresh,
    ...keep,
    createdAt: existing.createdAt || existing.updatedAt || fresh.createdAt || null,
  };
  await setJson(store, key, row);
  return { created: false, order: row };
}

module.exports = {
  FULFILLMENT_STATUSES,
  STATUS_FILTERS,
  TYPE_FILTERS,
  ORDER_KINDS,
  ORDER_ID_RE,
  ACTIONS,
  parseStatus,
  orderKind,
  fulfillmentStatusOf,
  normalizeOrder,
  isOpen,
  matchesFilters,
  filterOrders,
  applyStatus,
  newOrderFulfillment,
  upsertOrder,
};

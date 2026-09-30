#!/usr/bin/env node
/* eslint-disable no-console */
"use strict";

/**
 * Fulfillable order rows written by stripe-webhook. No network, no real keys:
 * placeholder secrets + the Stripe SDK's test-signature helper, and an
 * in-memory Netlify Blobs stand-in with real get/set/list semantics.
 *
 *   node scripts/test-renewals.js      (or: npm run test:renewals)
 *
 * Covers: one-time + initial subscription order rows, one renewal row per
 * paid renewal invoice (fields copied from the subscription metadata), the
 * first invoice (billing_reason subscription_create) NOT double-counted,
 * idempotency on Stripe retries (no duplicates, admin status kept), legacy
 * rows, both invoice payload shapes (pre/post Stripe API 2025-03), and the
 * admin-orders subscription filter picking up initial + renewal rows.
 */

const path = require("path");
const assert = require("assert");

const ROOT = path.resolve(__dirname, "..");
const FN = (p) => path.join(ROOT, "netlify/functions", p);
const SECRET = "unit-test-placeholder-webhook-secret";
process.env.STRIPE_SECRET_KEY = "unit-test-placeholder-not-a-stripe-key";
process.env.STRIPE_WEBHOOK_SECRET = SECRET;

// --- In-memory Netlify Blobs -------------------------------------------------
const stores = { orders: new Map(), subs: new Map() };
let writes = 0;
const memStore = (name) => ({
  get: async (key) => {
    const v = stores[name].get(key);
    return v === undefined ? null : JSON.parse(v);
  },
  setJSON: async (key, value) => {
    writes++;
    stores[name].set(key, JSON.stringify(value));
  },
  list: async () => ({ blobs: [...stores[name].keys()].map((key) => ({ key })) }),
});
const blobs = require(FN("lib/blobs.js"));
blobs.ordersStore = () => memStore("orders");
blobs.subsStore = () => memStore("subs");
blobs.setJson = async (store, key, value) => store.setJSON(key, value);

const { handler: webhook } = require(FN("stripe-webhook.js"));
const { handler: adminOrders } = require(FN("admin-orders.js"));
const { handler: adminFulfill } = require(FN("admin-fulfill.js"));
const { getStripe } = require(FN("lib/stripe-client.js"));
const stripe = getStripe();

const realError = console.error;
const logged = [];
console.error = (...a) => logged.push(a.join(" "));

let passed = 0;
function check(cond, msg) {
  assert.ok(cond, msg);
  passed++;
}

const orders = () => [...stores.orders.values()].map((v) => JSON.parse(v));
const order = (k) => (stores.orders.has(k) ? JSON.parse(stores.orders.get(k)) : null);
const sub = (k) => (stores.subs.has(k) ? JSON.parse(stores.subs.get(k)) : null);

let evtN = 0;
function send(type, object, { sign = true } = {}) {
  const body = JSON.stringify({ id: `evt_test_${++evtN}`, object: "event", type, data: { object } });
  const headers = sign
    ? { "stripe-signature": stripe.webhooks.generateTestHeaderString({ payload: body, secret: SECRET }) }
    : {};
  return webhook({ httpMethod: "POST", headers, body });
}

const DAN = { clientContext: { user: { email: "DWhigham94@gmail.com", sub: "dan" } } };
const listOrders = async (status, type, ctx = DAN) => {
  const r = await adminOrders(
    { httpMethod: "GET", headers: {}, queryStringParameters: { status, type } },
    ctx
  );
  return { status: r.statusCode, ...JSON.parse(r.body) };
};
const fulfill = async (body, ctx = DAN) => {
  const r = await adminFulfill({ httpMethod: "POST", headers: {}, body: JSON.stringify(body) }, ctx);
  return { status: r.statusCode, ...JSON.parse(r.body) };
};

const SUB_META = {
  leadType: "general-life",
  leadTypeLabel: "General Life",
  ageBandId: "lm-u30",
  ageBandLabel: "Under 30 days",
  quantity: "250",
  unitPrice: "0.52",
  billingCadence: "weekly",
  states: "FL,TX,GA",
  contactMethods: "Text,Email",
  contactOther: "",
  source: "lead-reload-hq",
};

const oneTimeSession = {
  id: "cs_test_onetime_1",
  object: "checkout.session",
  mode: "payment",
  amount_total: 5200,
  currency: "usd",
  created: 1790000000,
  customer: "cus_one",
  customer_details: { email: "onetime@example.com" },
  payment_intent: "pi_test_onetime_1",
  metadata: { ...SUB_META, quantity: "100", billingCadence: "one-time", states: "FL" },
};

const subSession = {
  id: "cs_test_weekly_1",
  object: "checkout.session",
  mode: "subscription",
  amount_total: 13000,
  currency: "usd",
  created: 1790000100,
  customer: "cus_weekly",
  customer_email: "weekly@example.com",
  subscription: "sub_test_weekly_1",
  invoice: "in_test_first_1",
  payment_intent: null,
  metadata: SUB_META,
};

const invoice = (id, billing_reason, extra = {}) => ({
  id,
  object: "invoice",
  billing_reason,
  subscription: "sub_test_weekly_1",
  customer: "cus_weekly",
  customer_email: "weekly@example.com",
  amount_paid: 13000,
  total: 13000,
  currency: "usd",
  created: 1790600000,
  status_transitions: { paid_at: 1790600100 },
  payment_intent: `pi_for_${id}`,
  subscription_details: { metadata: SUB_META },
  lines: { data: [{ period: { start: 1790604900, end: 1791209700 } }] },
  ...extra,
});

(async () => {
  let r;

  // --- One-time order ---------------------------------------------------------
  r = await send("checkout.session.completed", oneTimeSession);
  check(r.statusCode === 200, "one-time checkout → 200");
  let o = order("cs_test_onetime_1");
  check(o && o.kind === "one-time" && o.type === "one-time", "one-time row kind");
  check(o.fulfillmentStatus === "New" && o.completedAt === null && o.completedBy === null, "one-time row starts New");
  check(o.statusUpdatedAt === null && o.statusUpdatedBy === null, "status audit fields present, empty");
  check(o.stripePaymentIntentId === "pi_test_onetime_1" && o.amountTotal === 5200, "one-time ids/amount unchanged");
  check(o.status === "open" && o.email === "onetime@example.com" && o.qty === 100, "existing one-time fields kept");
  check(typeof o.createdAt === "string", "createdAt stamped");

  // --- Subscription checkout: sub record + initial order row -----------------
  r = await send("checkout.session.completed", subSession);
  check(r.statusCode === 200, "subscription checkout → 200");
  const s0 = sub("sub_test_weekly_1");
  check(s0 && s0.status === "active" && s0.billingCadence === "weekly", "subscription record still written");
  o = order("cs_test_weekly_1");
  check(o && o.kind === "subscription", "initial subscription order row keyed by session id");
  check(o.stripeSubscriptionId === "sub_test_weekly_1" && o.stripeInvoiceId === "in_test_first_1", "initial row links sub + first invoice");
  check(o.amountTotal === 13000 && o.billingCadence === "weekly" && o.qty === 250, "initial row amount/cadence/qty");
  check(o.metadata.states === "FL,TX,GA" && o.fulfillmentStatus === "New", "initial row states + New");
  check(orders().length === 2, "2 order rows so far");

  // --- First invoice (subscription_create): no second row --------------------
  r = await send("invoice.paid", invoice("in_test_first_1", "subscription_create"));
  check(r.statusCode === 200, "first invoice → 200");
  check(orders().length === 2, "subscription_create invoice does NOT add an order row (no double count)");
  check(!order("in_test_first_1"), "no row keyed by the first invoice id");
  check(sub("sub_test_weekly_1").lastInvoiceId === "in_test_first_1", "sub record still gets lastInvoiceId");

  // --- Renewal (subscription_cycle): its own row -----------------------------
  const renewal1 = invoice("in_test_renew_1", "subscription_cycle");
  r = await send("invoice.paid", renewal1);
  check(r.statusCode === 200, "renewal invoice → 200");
  check(orders().length === 3, "renewal adds exactly one row");
  o = order("in_test_renew_1");
  check(o && o.kind === "renewal" && o.type === "renewal", "renewal row kind");
  check(o.stripeInvoiceId === "in_test_renew_1" && o.stripeSubscriptionId === "sub_test_weekly_1", "renewal row invoice + sub ids");
  check(o.stripePaymentIntentId === "pi_for_in_test_renew_1" && o.stripeSessionId === null, "renewal payment intent, no session");
  check(o.amountTotal === 13000 && o.currency === "usd", "renewal amount = amount_paid");
  check(o.paidAt === new Date(1790600100 * 1000).toISOString(), "renewal paidAt = status_transitions.paid_at");
  check(o.periodStart === new Date(1790604900 * 1000).toISOString(), "renewal periodStart from line period");
  check(o.periodEnd === new Date(1791209700 * 1000).toISOString(), "renewal periodEnd from line period");
  check(o.metadata.leadTypeLabel === "General Life" && o.metadata.ageBandLabel === "Under 30 days", "lead type / age band copied");
  check(o.qty === 250 && o.metadata.states === "FL,TX,GA" && o.billingCadence === "weekly", "qty / states / cadence copied");
  check(o.billingReason === "subscription_cycle" && o.email === "weekly@example.com", "billing reason + email");
  check(o.fulfillmentStatus === "New" && o.contact && o.contact.methods.join() === "Text,Email", "renewal New + contact from sub record");
  check(sub("sub_test_weekly_1").lastInvoiceId === "in_test_renew_1", "sub record lastInvoiceId updated");

  // --- Idempotency: Stripe retries the same renewal ---------------------------
  const before = order("in_test_renew_1");
  r = await send("invoice.paid", renewal1);
  r = await send("invoice.paid", renewal1);
  check(r.statusCode === 200 && orders().length === 3, "retried renewal → still 3 rows");
  check(order("in_test_renew_1").createdAt === before.createdAt, "retry keeps createdAt");

  // Admin completes the renewal, then Stripe retries again: status survives.
  let f = await fulfill({ orderId: "in_test_renew_1", action: "complete" });
  check(f.status === 200 && f.order.fulfillmentStatus === "Completed", "admin completes renewal");
  check(f.order.completedBy === "dwhigham94@gmail.com", "completedBy = normalized admin email");
  r = await send("invoice.paid", renewal1);
  o = order("in_test_renew_1");
  check(orders().length === 3, "retry after completion → no duplicate");
  check(o.fulfillmentStatus === "Completed" && o.completedBy === "dwhigham94@gmail.com" && o.completedAt === f.order.completedAt, "retry keeps Completed/completedAt/completedBy");
  check(o.statusUpdatedBy === "dwhigham94@gmail.com" && o.status === "fulfilled", "retry keeps audit + legacy mirror");

  // Same for checkout.session.completed retries.
  await fulfill({ orderId: "cs_test_onetime_1", action: "start" });
  r = await send("checkout.session.completed", oneTimeSession);
  check(order("cs_test_onetime_1").fulfillmentStatus === "In progress", "one-time retry keeps In progress");
  await send("checkout.session.completed", subSession);
  check(orders().length === 3, "subscription checkout retry → no duplicate");
  // ...and a retried first invoice still adds nothing.
  await send("invoice.paid", invoice("in_test_first_1", "subscription_create"));
  check(orders().length === 3, "retried subscription_create → still no extra row");

  // --- Second renewal: another row --------------------------------------------
  await send("invoice.paid", invoice("in_test_renew_2", "subscription_cycle", {
    status_transitions: { paid_at: 1791209800 },
    lines: { data: [{ period: { start: 1791209700, end: 1791814500 } }] },
  }));
  check(orders().length === 4 && order("in_test_renew_2").kind === "renewal", "second renewal → 4th row");

  // --- Metadata fallback: invoice without subscription_details ----------------
  await send("invoice.paid", invoice("in_test_renew_3", "subscription_cycle", { subscription_details: undefined, customer_email: null }));
  o = order("in_test_renew_3");
  check(o && o.metadata.ageBandLabel === "Under 30 days" && o.qty === 250, "renewal falls back to stored subscription metadata");
  check(o.email === "weekly@example.com", "renewal falls back to subscription email");

  // --- Newer Stripe API shape (invoice.parent.subscription_details) ----------
  const basil = invoice("in_test_basil_1", "subscription_cycle", {
    subscription: undefined,
    subscription_details: undefined,
    payment_intent: undefined,
    parent: {
      type: "subscription_details",
      subscription_details: { subscription: "sub_test_weekly_1", metadata: { ...SUB_META, quantity: "300" } },
    },
  });
  await send("invoice.paid", basil);
  o = order("in_test_basil_1");
  check(o && o.kind === "renewal" && o.stripeSubscriptionId === "sub_test_weekly_1", "parent.subscription_details shape handled");
  check(o.qty === 300 && o.stripePaymentIntentId === null, "parent shape metadata used; missing PI → null");
  await send("invoice.paid", { ...basil, billing_reason: "subscription_create", id: "in_test_basil_first" });
  check(!order("in_test_basil_first"), "parent shape subscription_create also skipped");

  // --- Non-subscription invoice: ignored --------------------------------------
  const n = orders().length;
  await send("invoice.paid", { id: "in_test_oneoff", object: "invoice", billing_reason: "manual", amount_paid: 100, currency: "usd" });
  check(orders().length === n && !order("in_test_oneoff"), "invoice without a subscription → no row");

  // --- Unsigned events never write ---------------------------------------------
  const w = writes;
  r = await send("invoice.paid", invoice("in_test_forged", "subscription_cycle"), { sign: false });
  check(r.statusCode === 400 && r.body === "missing_signature", "unsigned invoice.paid → 400");
  check(writes === w && !order("in_test_forged"), "unsigned invoice.paid writes nothing");

  // --- Legacy row (pre-fulfillment fields) + retry ---------------------------
  stores.orders.set("cs_test_legacy_done", JSON.stringify({
    id: "cs_test_legacy_done", type: "one-time", status: "fulfilled",
    fulfilledAt: "2026-09-27T12:00:00.000Z", email: "old@example.com", paidAt: "2026-09-27T10:00:00.000Z",
  }));
  stores.orders.set("cs_test_legacy_open", JSON.stringify({
    id: "cs_test_legacy_open", type: "one-time", status: "open", email: "old2@example.com", paidAt: "2026-09-27T09:00:00.000Z",
  }));
  await send("checkout.session.completed", { ...oneTimeSession, id: "cs_test_legacy_done" });
  o = order("cs_test_legacy_done");
  check(o.fulfillmentStatus === "Completed" && o.completedAt === "2026-09-27T12:00:00.000Z", "legacy fulfilled row stays Completed on retry");

  // --- admin-orders filters over webhook rows ---------------------------------
  let L = await listOrders("all", "subscription");
  const kinds = L.orders.map((x) => x.kind).sort();
  check(L.status === 200 && kinds.includes("subscription") && kinds.includes("renewal"), "subscription filter = initial + renewals");
  check(L.orders.every((x) => x.kind !== "one-time"), "subscription filter excludes one-time");
  check(L.orders.length === 5, `subscription filter count (got ${L.orders.length})`);
  L = await listOrders("all", "one-time");
  check(L.orders.length === 3 && L.orders.every((x) => x.kind === "one-time"), "one-time filter");
  L = await listOrders("open", "subscription");
  check(!L.orders.some((x) => x.id === "in_test_renew_1"), "completed renewal not in open");
  L = await listOrders("completed", "all");
  check(L.orders.map((x) => x.id).sort().join() === "cs_test_legacy_done,in_test_renew_1", "completed filter incl. legacy fulfilled");
  L = await listOrders("open", "one-time");
  check(L.orders.find((x) => x.id === "cs_test_legacy_open").fulfillmentStatus === "New", "legacy open row reads as New");
  check(!("fulfillmentStatus" in JSON.parse(stores.orders.get("cs_test_legacy_open"))), "reads do not rewrite legacy rows");

  console.error = realError;
  console.log(`PASS — renewal/order rows: ${passed} assertions`);
})().catch((err) => {
  console.error = realError;
  console.error("FAIL:", err && err.message ? err.message : err);
  if (logged.length) console.error(logged.join("\n"));
  process.exit(1);
});

#!/usr/bin/env node
/* eslint-disable no-console */
"use strict";

/**
 * Order fulfillment tracking: status model, admin API, admin UI wiring, CSV.
 * No network: Netlify Blobs is an in-memory stand-in and the Identity user
 * is a fake context.clientContext.user (as in test-admin-auth.js).
 *
 *   node scripts/test-fulfillment.js      (or: npm run test:fulfillment)
 */

const fs = require("fs");
const path = require("path");
const assert = require("assert");

const ROOT = path.resolve(__dirname, "..");
const FN = (p) => path.join(ROOT, "netlify/functions", p);

let passed = 0;
function check(cond, msg) {
  assert.ok(cond, msg);
  passed++;
}

// --- In-memory Netlify Blobs -------------------------------------------------
const mem = new Map();
let storeCalls = 0;
const memStore = () => ({
  get: async (key) => {
    storeCalls++;
    return mem.has(key) ? JSON.parse(mem.get(key)) : null;
  },
  setJSON: async (key, value) => {
    storeCalls++;
    mem.set(key, JSON.stringify(value));
  },
  list: async () => {
    storeCalls++;
    return { blobs: [...mem.keys()].map((key) => ({ key })) };
  },
});
const blobs = require(FN("lib/blobs.js"));
blobs.ordersStore = () => memStore();
blobs.subsStore = () => memStore();
blobs.setJson = async (store, key, value) => store.setJSON(key, value);

const lib = require(FN("lib/orders.js"));
const { handler: adminOrders } = require(FN("admin-orders.js"));
const { handler: adminFulfill } = require(FN("admin-fulfill.js"));
const view = require(path.join(ROOT, "public/admin/orders-view.js"));

const ctx = (email) => ({ clientContext: { user: { email, sub: "x" } } });
const DAN = ctx("dwhigham94@gmail.com");
const ZAC = ctx(" ZacFischer10x@gmail.com ");
const NOBODY = { clientContext: {} };
const OTHER = ctx("attacker@example.com");

const seed = () => {
  mem.clear();
  const rows = [
    { id: "cs_one_new", type: "one-time", status: "open", paidAt: "2026-09-28T10:00:00.000Z", email: "a@example.com" },
    { id: "cs_one_legacy_done", type: "one-time", status: "fulfilled", fulfilledAt: "2026-09-27T12:00:00.000Z", paidAt: "2026-09-27T10:00:00.000Z" },
    { id: "cs_sub_first", kind: "subscription", type: "subscription", fulfillmentStatus: "In progress", paidAt: "2026-09-26T10:00:00.000Z" },
    { id: "in_renew_1", kind: "renewal", type: "renewal", fulfillmentStatus: "Completed", completedAt: "2026-09-28T11:00:00.000Z", completedBy: "zacfischer10x@gmail.com", paidAt: "2026-09-28T09:00:00.000Z" },
    { id: "in_renew_2", kind: "renewal", type: "renewal", fulfillmentStatus: "New", paidAt: "2026-09-28T12:00:00.000Z" },
    { id: "cs_weird", type: "something-else", fulfillmentStatus: "bogus", paidAt: "2026-09-20T12:00:00.000Z" },
  ];
  for (const r of rows) mem.set(r.id, JSON.stringify(r));
};

const list = async (q, c = DAN) => {
  const r = await adminOrders({ httpMethod: "GET", headers: {}, queryStringParameters: q }, c);
  return { status: r.statusCode, headers: r.headers, ...JSON.parse(r.body) };
};
const post = async (body, c = DAN, raw) => {
  const r = await adminFulfill(
    { httpMethod: "POST", headers: {}, body: raw !== undefined ? raw : JSON.stringify(body) },
    c
  );
  return { status: r.statusCode, headers: r.headers, ...JSON.parse(r.body) };
};
const row = (id) => JSON.parse(mem.get(id));

(async () => {
  // --- lib/orders: normalization (backward-compatible reads) -----------------
  check(lib.normalizeOrder({}).fulfillmentStatus === "New", "no status → New");
  check(lib.normalizeOrder({ status: "open" }).fulfillmentStatus === "New", "legacy open → New");
  const legacy = lib.normalizeOrder({ status: "fulfilled", fulfilledAt: "T1" });
  check(legacy.fulfillmentStatus === "Completed" && legacy.completedAt === "T1", "legacy fulfilled → Completed, completedAt=fulfilledAt");
  check(lib.normalizeOrder({ fulfillmentStatus: "bogus" }).fulfillmentStatus === "New", "unknown status → New");
  check(lib.normalizeOrder({ fulfillmentStatus: "New", completedAt: "x", completedBy: "y" }).completedAt === null, "non-completed rows never expose completedAt");
  check(lib.normalizeOrder({ type: "one-time" }).kind === "one-time", "type one-time → kind one-time");
  check(lib.normalizeOrder({}).kind === "one-time", "missing kind → one-time");
  check(lib.normalizeOrder({ kind: "renewal" }).kind === "renewal", "kind renewal kept");
  const frozen = Object.freeze({ status: "fulfilled" });
  lib.normalizeOrder(frozen); // must not throw / mutate
  check(true, "normalize does not mutate");

  // parseStatus
  for (const [inp, out] of [
    ["New", "New"], ["new", "New"], ["open", "New"],
    ["In progress", "In progress"], ["in_progress", "In progress"], ["in-progress", "In progress"],
    ["Completed", "Completed"], ["complete", "Completed"], ["fulfilled", "Completed"],
    ["done", null], ["", null], [null, null], [5, null], [{}, null],
  ]) {
    check(lib.parseStatus(inp) === out, `parseStatus(${JSON.stringify(inp)}) → ${out}`);
  }

  // applyStatus transitions
  const t0 = new Date("2026-09-28T20:00:00.000Z");
  let a = lib.applyStatus({ id: "x" }, "In progress", "dan@x", t0);
  check(a.changed && a.order.fulfillmentStatus === "In progress", "New → In progress");
  check(a.order.completedAt === null && a.order.completedBy === null, "In progress has no completedAt/By");
  check(a.order.statusUpdatedAt === t0.toISOString() && a.order.statusUpdatedBy === "dan@x", "statusUpdatedAt/By set");
  a = lib.applyStatus(a.order, "Completed", "zac@x", t0);
  check(a.order.completedAt === t0.toISOString() && a.order.completedBy === "zac@x", "→ Completed stamps completedAt/By");
  check(a.order.status === "fulfilled" && a.order.fulfilledAt === t0.toISOString(), "legacy mirror on complete");
  const again = lib.applyStatus(a.order, "Completed", "dan@x", new Date("2026-09-29T00:00:00.000Z"));
  check(!again.changed && again.order.completedBy === "zac@x" && again.order.completedAt === t0.toISOString(), "re-complete is a no-op (keeps original)");
  const back = lib.applyStatus(a.order, "In progress", "dan@x", t0);
  check(back.order.completedAt === null && back.order.completedBy === null, "Completed → In progress clears completedAt/By");
  check(back.order.status === "open" && back.order.fulfilledAt === null, "legacy mirror cleared");
  const reopen = lib.applyStatus(a.order, "New", "dan@x", t0);
  check(reopen.order.fulfillmentStatus === "New" && reopen.order.completedAt === null, "Completed → New clears");
  assert.throws(() => lib.applyStatus({}, "Done", "d"), /invalid_status/);
  check(true, "applyStatus rejects unknown status");

  // filters (lib)
  const recs = [{ kind: "one-time" }, { kind: "subscription" }, { kind: "renewal" }, { kind: "renewal", fulfillmentStatus: "Completed" }, { status: "fulfilled" }];
  check(lib.filterOrders(recs, { status: "open" }).length === 3, "lib open filter");
  check(lib.filterOrders(recs, { status: "completed" }).length === 2, "lib completed filter");
  check(lib.filterOrders(recs, { type: "subscription" }).length === 3, "lib subscription filter includes renewals");
  check(lib.filterOrders(recs, { type: "one-time" }).length === 2, "lib one-time filter");
  check(lib.filterOrders(recs, { status: "open", type: "subscription" }).length === 2, "lib combined filter");

  // --- admin-orders: auth ------------------------------------------------------
  seed();
  storeCalls = 0;
  let L = await list({ status: "open" }, NOBODY);
  check(L.status === 401 && L.reason === "unauthorized" && storeCalls === 0, "admin-orders without login → 401, storage untouched");
  L = await list({}, null);
  check(L.status === 401, "admin-orders null context → 401");
  L = await list({}, OTHER);
  check(L.status === 403 && storeCalls === 0, "admin-orders other email → 403");
  check(/no-store/.test(L.headers["Cache-Control"]), "admin-orders no-store");

  // --- admin-orders: filters ---------------------------------------------------
  const ids = (x) => x.orders.map((o) => o.id);
  L = await list(undefined);
  check(L.status === 200 && L.orders.length === 6, "no params → all rows (backward compatible)");
  check(ids(L).join() === "in_renew_2,cs_one_new,in_renew_1,cs_one_legacy_done,cs_sub_first,cs_weird", "sorted newest first");
  check(L.filters.status === "all" && L.filters.type === "all", "defaults all/all");
  check(L.counts.all === 6 && L.counts.completed === 2 && L.counts.open === 4, "counts");
  check(L.orders.every((o) => lib.FULFILLMENT_STATUSES.includes(o.fulfillmentStatus)), "every row has a valid fulfillmentStatus");
  L = await list({ status: "open", type: "all" });
  check(ids(L).sort().join() === "cs_one_new,cs_sub_first,cs_weird,in_renew_2", "open = New + In progress");
  L = await list({ status: "completed" });
  check(ids(L).sort().join() === "cs_one_legacy_done,in_renew_1", "completed (incl. legacy fulfilled)");
  L = await list({ type: "subscription" });
  check(ids(L).sort().join() === "cs_sub_first,in_renew_1,in_renew_2", "subscription = initial + renewals");
  check(L.counts.all === 3 && L.counts.completed === 1 && L.counts.open === 2, "counts follow the type filter");
  L = await list({ type: "one-time" });
  check(ids(L).sort().join() === "cs_one_legacy_done,cs_one_new,cs_weird", "one-time (unknown kinds read as one-time)");
  L = await list({ status: "open", type: "subscription" });
  check(ids(L).sort().join() === "cs_sub_first,in_renew_2", "open + subscription");
  L = await list({ status: "COMPLETED", type: "One-Time" });
  check(ids(L).join() === "cs_one_legacy_done", "filters are case-insensitive");
  for (const [q, reason] of [
    [{ status: "fulfilled" }, "invalid_status_filter"],
    [{ status: "<script>" }, "invalid_status_filter"],
    [{ type: "renewal" }, "invalid_type_filter"],
    [{ type: "weekly" }, "invalid_type_filter"],
  ]) {
    L = await list(q);
    check(L.status === 400 && L.reason === reason, `${JSON.stringify(q)} → 400 ${reason}`);
  }
  check(!("fulfillmentStatus" in row("cs_one_new")), "listing does not rewrite rows");

  // --- admin-fulfill: auth ---------------------------------------------------
  storeCalls = 0;
  let P = await post({ orderId: "cs_one_new", action: "complete" }, NOBODY);
  check(P.status === 401 && P.reason === "unauthorized" && storeCalls === 0, "admin-fulfill without login → 401, storage untouched");
  P = await post({ orderId: "cs_one_new", action: "complete" }, OTHER);
  check(P.status === 403 && storeCalls === 0, "admin-fulfill other email → 403");
  check(row("cs_one_new").fulfillmentStatus === undefined, "unauthorized calls change nothing");
  const g = await adminFulfill({ httpMethod: "GET", headers: {} }, DAN);
  check(g.statusCode === 405, "admin-fulfill GET → 405");

  // --- admin-fulfill: validation --------------------------------------------
  for (const [body, reason, raw] of [
    [{}, "missing_order_id"],
    [{ action: "complete" }, "missing_order_id"],
    [null, "missing_order_id", "not json"],
    [null, "missing_order_id", "[1,2]"],
    [{ orderId: 123, action: "complete" }, "invalid_order_id"],
    [{ orderId: ["cs_one_new"], action: "complete" }, "invalid_order_id"],
    [{ orderId: "../etc/passwd", action: "complete" }, "invalid_order_id"],
    [{ orderId: "cs one", action: "complete" }, "invalid_order_id"],
    [{ orderId: "x".repeat(201), action: "complete" }, "invalid_order_id"],
    [{ orderId: "cs_one_new" }, "invalid_status"],
    [{ orderId: "cs_one_new", status: "Done" }, "invalid_status"],
    [{ orderId: "cs_one_new", status: 1 }, "invalid_status"],
    [{ orderId: "cs_one_new", action: "delete" }, "invalid_action"],
    [{ orderId: "cs_one_new", action: "toString" }, "invalid_action"],
    [{ orderId: "cs_one_new", action: "__proto__" }, "invalid_action"],
    [{ orderId: "cs_one_new", action: ["complete"] }, "invalid_action"],
  ]) {
    P = await post(body, DAN, raw);
    check(P.status === 400 && P.reason === reason, `${raw || JSON.stringify(body).slice(0, 60)} → 400 ${reason} (got ${P.status} ${P.reason})`);
  }
  check(row("cs_one_new").fulfillmentStatus === undefined, "invalid requests change nothing");
  P = await post({ orderId: "cs_missing", action: "complete" });
  check(P.status === 404 && P.reason === "not_found", "unknown order → 404");

  // --- admin-fulfill: transitions --------------------------------------------
  P = await post({ orderId: "cs_one_new", action: "start" }, ZAC);
  check(P.status === 200 && P.changed === true, "start → 200 changed");
  let r = row("cs_one_new");
  check(r.fulfillmentStatus === "In progress" && r.statusUpdatedBy === "zacfischer10x@gmail.com", "In progress stored, statusUpdatedBy = Zac (normalized)");
  check(r.completedAt === null && r.completedBy === null, "In progress: no completedAt/By");

  const beforeComplete = Date.now();
  P = await post({ orderId: "cs_one_new", action: "complete" }, DAN);
  r = row("cs_one_new");
  check(P.status === 200 && r.fulfillmentStatus === "Completed", "complete → Completed");
  check(r.completedBy === "dwhigham94@gmail.com", "completedBy = admin Identity email");
  check(Date.parse(r.completedAt) >= beforeComplete - 1000 && Date.parse(r.completedAt) <= Date.now() + 1000, "completedAt = now");
  check(r.statusUpdatedAt === r.completedAt && r.statusUpdatedBy === "dwhigham94@gmail.com", "status audit on complete");
  check(r.status === "fulfilled" && r.fulfilledAt === r.completedAt, "legacy status mirror");
  check(r.email === "a@example.com" && r.paidAt === "2026-09-28T10:00:00.000Z", "other fields untouched");

  const firstCompletedAt = r.completedAt;
  P = await post({ orderId: "cs_one_new", action: "complete" }, ZAC);
  check(P.status === 200 && P.changed === false, "complete again → no-op");
  check(row("cs_one_new").completedBy === "dwhigham94@gmail.com" && row("cs_one_new").completedAt === firstCompletedAt, "no-op keeps original completer");

  P = await post({ orderId: "cs_one_new", action: "reopen" }, ZAC);
  r = row("cs_one_new");
  check(r.fulfillmentStatus === "New" && r.completedAt === null && r.completedBy === null, "reopen → New, completedAt/By cleared");
  check(r.statusUpdatedBy === "zacfischer10x@gmail.com", "reopen audit");

  P = await post({ orderId: "in_renew_1", status: "In progress" });
  r = row("in_renew_1");
  check(r.fulfillmentStatus === "In progress" && r.completedAt === null && r.completedBy === null, "Completed → In progress (status param) clears completedAt/By");
  P = await post({ orderId: "in_renew_1", status: "Completed" }, ZAC);
  check(row("in_renew_1").completedBy === "zacfischer10x@gmail.com", "status=Completed also stamps completedBy");

  // legacy aliases from a cached older admin page
  P = await post({ orderId: "cs_one_legacy_done", status: "open" });
  check(P.status === 200 && row("cs_one_legacy_done").fulfillmentStatus === "New", "legacy status 'open' → New");
  check(row("cs_one_legacy_done").fulfilledAt === null, "legacy fulfilledAt cleared on reopen");
  P = await post({ orderId: "cs_one_legacy_done", status: "fulfilled" });
  check(row("cs_one_legacy_done").fulfillmentStatus === "Completed", "legacy status 'fulfilled' → Completed");

  // action wins over status
  P = await post({ orderId: "cs_sub_first", action: "complete", status: "New" });
  check(row("cs_sub_first").fulfillmentStatus === "Completed", "action takes precedence over status");
  const opt = await adminFulfill({ httpMethod: "OPTIONS", headers: {} }, {});
  check(opt.statusCode === 204, "OPTIONS → 204");

  // --- CSV export (public/admin/orders-view.js) ------------------------------
  const { csvCell, toCsv, CSV_COLUMNS } = view;
  check(csvCell("plain") === "plain", "plain cell unquoted");
  check(csvCell("a,b") === '"a,b"', "comma → quoted");
  check(csvCell('say "hi"') === '"say ""hi"""', "quotes doubled");
  check(csvCell("line1\nline2") === '"line1\nline2"', "newline → quoted");
  check(csvCell("line1\r\nline2") === '"line1\r\nline2"', "CRLF → quoted");
  check(csvCell(null) === "" && csvCell(undefined) === "", "null/undefined → empty");
  check(csvCell(52) === "52" && csvCell("52.00") === "52.00", "numbers as-is");
  check(csvCell("=HYPERLINK(\"http://x\")") === "\"'=HYPERLINK(\"\"http://x\"\")\"", "= formula neutralized + quoted");
  check(csvCell("=1+2") === "'=1+2", "= prefixed with '");
  check(csvCell("+1 555") === "'+1 555", "+ prefixed");
  check(csvCell("-2+3") === "'-2+3", "- prefixed");
  check(csvCell("@SUM(A1)") === "'@SUM(A1)", "@ prefixed");
  check(csvCell("\t=1") === "'\t=1", "leading tab prefixed");
  check(csvCell("\r=1") === "\"'\r=1\"", "CR prefixed and quoted");
  check(csvCell("a=b") === "a=b" && csvCell("x@y.com") === "x@y.com", "= / @ mid-cell left alone");
  check(csvCell(" padded ") === '" padded "', "edge whitespace quoted");

  const header = CSV_COLUMNS.map(([h]) => h);
  for (const need of [
    "Paid at (UTC)", "Customer email", "Lead type", "Age band", "Quantity", "States", "Amount",
    "Cadence / type", "Stripe session id", "Payment intent id", "Invoice id", "Fulfillment status",
    "Completed at", "Completed by",
  ]) {
    check(header.includes(need), `CSV has column "${need}"`);
  }
  const sample = [
    {
      id: "cs_1", kind: "one-time", paidAt: "2026-09-28T10:00:00.000Z", email: "=evil@example.com",
      amountTotal: 5200, currency: "usd", qty: 100, stripeSessionId: "cs_1", stripePaymentIntentId: "pi_1",
      metadata: { leadTypeLabel: "General Life", ageBandLabel: "Under 30 days", states: "FL,TX", quantity: "100" },
      fulfillmentStatus: "Completed", completedAt: "2026-09-28T11:00:00.000Z", completedBy: "dwhigham94@gmail.com",
    },
    {
      id: "in_2", kind: "renewal", billingCadence: "weekly", paidAt: "2026-09-28T12:00:00.000Z",
      email: "b@example.com", amountTotal: 13000, currency: "usd", stripeInvoiceId: "in_2",
      stripeSubscriptionId: "sub_1", metadata: { leadTypeLabel: 'Private "Health", Inc', states: "GA", quantity: "250" },
    },
    { id: "cs_3", kind: "subscription", billingCadence: "monthly", metadata: {} },
    { id: "cs_4", status: "fulfilled", fulfilledAt: "T" },
  ];
  const csv = toCsv(sample);
  const lines = csv.split("\r\n");
  check(csv.endsWith("\r\n") && lines.length === 6, "CRLF rows, header + 4 rows + trailing newline");
  check(lines[0].split(",").length === CSV_COLUMNS.length, "header column count");
  const r1 = lines[1];
  check(r1.includes(",'=evil@example.com,"), "formula-looking email neutralized");
  check(r1.includes(',"FL, TX",') && r1.includes(",52.00,USD,One-time,cs_1,pi_1,"), "row 1 states / amount / cadence / ids");
  check(r1.includes(",Completed,2026-09-28T11:00:00.000Z,dwhigham94@gmail.com,"), "row 1 status + completedAt/By");
  check(lines[2].includes(',"Private ""Health"", Inc",') && lines[2].includes(",Weekly renewal,"), "row 2 quoted lead type + Weekly renewal");
  check(lines[2].includes(",in_2,sub_1,") && lines[2].includes(",New,"), "row 2 invoice/sub id + New default");
  check(lines[3].includes(",Monthly subscription,"), "row 3 Monthly subscription");
  check(lines[4].includes(",Completed,"), "legacy fulfilled row exports as Completed");
  check(toCsv([]).split("\r\n").length === 2, "empty export = header only");
  check(view.cadenceLabel({ kind: "subscription" }) === "Subscription" && view.cadenceLabel({ kind: "renewal" }) === "Renewal", "cadence labels without cadence");
  check(view.paymentRef({ stripeInvoiceId: "in_9" }) === "in_9", "payment ref falls back to invoice id");

  // --- Admin UI wiring --------------------------------------------------------
  const html = fs.readFileSync(path.join(ROOT, "public/admin/index.html"), "utf8");
  const js = fs.readFileSync(path.join(ROOT, "public/admin/admin.js"), "utf8");
  const css = fs.readFileSync(path.join(ROOT, "public/admin/admin.css"), "utf8");
  const vers = [...html.matchAll(/(admin\.css|admin\.js|orders-view\.js)\?v=([\w-]+)/g)].map((m) => m[2]);
  check(vers.length === 3 && new Set(vers).size === 1, "admin assets share one cache-bust version");
  check(vers[0] !== "20260926id", "admin cache-bust bumped from 20260926id");
  check(html.indexOf("orders-view.js") < html.indexOf('src="admin.js'), "orders-view.js loads before admin.js");
  for (const v of ["open", "completed", "all"]) check(html.includes(`data-status="${v}"`), `status filter ${v}`);
  for (const v of ["all", "one-time", "subscription"]) check(html.includes(`data-type="${v}"`), `type filter ${v}`);
  check(/id="export-btn"/.test(html), "Export CSV button");
  check(/Mark completed/.test(js) && /data-act="complete"/.test(js), "one-tap Mark completed");
  check(/data-act="start"/.test(js) && /data-act="reopen"/.test(js), "In progress + reopen actions");
  check(/admin-orders\?status=/.test(js) && /api\("admin-fulfill"/.test(js), "UI uses admin-orders filters + admin-fulfill");
  check(/V\.toCsv\(orders\)/.test(js), "CSV export uses the currently filtered rows");
  check(/max-width:\s*640px/.test(css), "mobile breakpoint present");

  console.log(`PASS — order fulfillment (API, transitions, filters, CSV, UI): ${passed} assertions`);
})().catch((err) => {
  console.error("FAIL:", err && err.message ? err.message : err);
  process.exit(1);
});

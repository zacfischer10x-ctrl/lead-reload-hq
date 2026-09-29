#!/usr/bin/env node
/* eslint-disable no-console */
"use strict";

/**
 * Business Owner Raw Data: $0.003 per record ($30 per 10k), one flat price
 * with no age band, $100 minimum order (raw total), up to 1,000,000 records
 * per order. No network, no real keys.
 *
 *   node scripts/test-bizowner.js      (or: npm run test:bizowner)
 *
 * Covers:
 *  - Server pricing (lib/pricing.js + create-checkout with a stubbed Stripe
 *    client) for every Business Owner preset (35,000 / 50,000 / 100,000 /
 *    250,000) × one-time / weekly / monthly: exact integer-cent totals,
 *    Stripe mode / interval, metadata.
 *  - $100 minimum on the raw total: 33,333 records ($99.999) → 400
 *    below_minimum (no Stripe session); 33,334 → $100.01 (rounded up from
 *    $100.002). Applies to every cadence.
 *  - Rounding for custom quantities: ceil(0.3¢ × qty) to a whole cent.
 *  - Max 1,000,000 records for Business Owner (1,000,001 → invalid_quantity);
 *    other products keep 100,000.
 *  - Tampered client prices / labels / bands are ignored or rejected.
 *  - Per-product presets in index.html; other products keep 50 … 10,000 and
 *    Dan's Life / Mortgage Protection / Private Health prices.
 *  - Storefront (public/app.js in a vm with a tiny fake DOM): Business Owner
 *    skips the Age step, shows its own presets and the $100 minimum, blocks
 *    Continue / Pay under 33,334 records with a message, and sends leadType
 *    business-owner + ageBandId bo-flat.
 *  - Banned wording in the new storefront copy.
 * Prints the preset pricing table.
 */

const fs = require("fs");
const path = require("path");
const vm = require("vm");
const assert = require("assert");

const ROOT = path.resolve(__dirname, "..");
const pricing = require(path.join(ROOT, "netlify/functions/lib/pricing.js"));

let passed = 0;
function check(cond, msg) {
  assert.ok(cond, msg);
  passed++;
}

const DEFAULT_PRESETS = [50, 100, 250, 500, 1000, 2500, 5000, 10000];
const BO_PRESETS = [35000, 50000, 100000, 250000];
const BO_PRESET_CENTS = { 35000: 10500, 50000: 15000, 100000: 30000, 250000: 75000 };
const CADENCES = ["one-time", "weekly", "monthly"];
const BO = "business-owner";
const BO_MIN_MSG = "Business Owner Raw Data has a $100.00 minimum order: at least 33,334 records.";

// ——— 0. Per-product presets in index.html ———
const HTML = fs.readFileSync(path.join(ROOT, "public/index.html"), "utf8");
function presetGroup(name) {
  const m = HTML.match(new RegExp(`<div class="qty-presets[^"]*" data-presets="${name}">([\\s\\S]*?)</div>`));
  return m ? [...m[1].matchAll(/data-qty="(\d+)"/g)].map((x) => Number(x[1])) : null;
}
check(JSON.stringify(presetGroup("default")) === JSON.stringify(DEFAULT_PRESETS), `default presets ${presetGroup("default")}`);
check(JSON.stringify(presetGroup("business-owner")) === JSON.stringify(BO_PRESETS), `business-owner presets ${presetGroup("business-owner")}`);
check(/<div class="qty-presets hidden" data-presets="business-owner">/.test(HTML), "Business Owner presets hidden until selected");
const allHtmlPresets = [...HTML.matchAll(/data-qty="(\d+)"/g)].map((m) => Number(m[1]));
check(JSON.stringify(allHtmlPresets) === JSON.stringify([...DEFAULT_PRESETS, ...BO_PRESETS]), "no other preset buttons");
const APP_SRC = fs.readFileSync(path.join(ROOT, "public/app.js"), "utf8");
check(APP_SRC.includes("const BUSINESS_OWNER_PRESETS = [35000, 50000, 100000, 250000];"), "app.js BUSINESS_OWNER_PRESETS");
check(!/chip-disabled/.test(APP_SRC) && !/chip-disabled/.test(HTML), "old 50/100 disabled-preset handling removed");

// ——— 1. Price table + limits ———
check(pricing.BUSINESS_OWNER_PER_RECORD === 0.003, "BUSINESS_OWNER_PER_RECORD = 0.003");
check(/const BUSINESS_OWNER_PER_RECORD = 0\.003;/.test(APP_SRC), "app.js BUSINESS_OWNER_PER_RECORD = 0.003 (display only)");
const boType = pricing.getLeadType(BO);
check(boType && boType.label === "Business Owner Raw Data" && boType.pricingKey === "businessOwner", "lead type");
check(boType.minOrderCents === 10000 && pricing.minOrderCentsFor(BO) === 10000, "$100 minimum (10000 cents)");
check(pricing.minQtyFor(BO) === 33334, `min qty ${pricing.minQtyFor(BO)}`);
check(pricing.maxQtyFor(BO) === 1000000, "BO max 1,000,000");
for (const t of ["general-life", "mortgage-protection", "private-health"]) {
  check(pricing.maxQtyFor(t) === 100000 && pricing.minOrderCentsFor(t) === 0 && pricing.minQtyFor(t) === 1, `${t}: cap 100,000, no product minimum`);
}
const boBands = pricing.PRICE_TABLES.businessOwner;
check(boBands.length === 1 && boBands[0].id === "bo-flat" && boBands[0].flat === true && boBands[0].unitMills === 3, "single flat band, 3 mills");
check(pricing.isFlatType(BO) && !pricing.isFlatType("general-life") && !pricing.isFlatType("private-health"), "isFlatType");
check(pricing.unitPriceString(boBands[0]) === "0.003", "unit price string");
// Dan's confirmed table is untouched.
const DAN = {
  lifeMp: [["lm-u30", 52], ["lm-30-60", 39], ["lm-60-90", 20], ["lm-90-365", 10], ["lm-365", 3]],
  privateHealth: [["ph-u30", 52], ["ph-30-60", 33], ["ph-60-90", 26], ["ph-90-365", 13], ["ph-365", 3]],
};
for (const key of Object.keys(DAN)) {
  check(JSON.stringify(pricing.PRICE_TABLES[key].map((b) => [b.id, b.unitCents])) === JSON.stringify(DAN[key]), `${key} table unchanged`);
}
check(Object.keys(pricing.PRICE_TABLES).sort().join() === "businessOwner,lifeMp,privateHealth", "only one new table");
// Other products at their existing presets: unchanged totals, no product minimum.
for (const [t, band, unit] of [["general-life", "lm-365", 3], ["mortgage-protection", "lm-u30", 52], ["private-health", "ph-90-365", 13]]) {
  for (const q of DEFAULT_PRESETS) {
    const r = pricing.quote({ leadType: t, ageBandId: band, quantity: q });
    const want = unit * q;
    if (want < 50) check(!r.ok && r.reason === "amount_too_small", `${t} ${q}: amount_too_small`);
    else check(r.ok && r.amountCents === want, `${t}/${band} × ${q} = ${want}c`);
  }
}

// ——— 2. quote(): presets × cadences ———
const table = [];
for (const q of BO_PRESETS) {
  const want = BO_PRESET_CENTS[q];
  check(want === q * 3 / 10, `${q}: preset total is exact (no rounding)`);
  for (const cadence of CADENCES) {
    const r = pricing.quote({ leadType: BO, ageBandId: "bo-flat", quantity: q, billingCadence: cadence });
    check(r.ok && r.amountCents === want && Number.isInteger(r.amountCents), `${q} ${cadence}: ${r.amountCents} != ${want}`);
    check(r.mode === (cadence === "one-time" ? "payment" : "subscription"), "mode");
    check(r.interval === { "one-time": null, weekly: "week", monthly: "month" }[cadence], "interval");
    check(r.unitPrice === "0.003" && r.flat === true && r.unit === "record", "unit");
  }
  table.push([q, want]);
}
check(pricing.quote({ leadType: BO, ageBandId: "bo-flat", quantity: 40000 }).amount === "120.00", "$30 per 10k (40,000 → $120.00)");

// $100 minimum on the raw total, every cadence.
for (const cadence of CADENCES) {
  const lo = pricing.quote({ leadType: BO, ageBandId: "bo-flat", quantity: 33333, billingCadence: cadence });
  check(!lo.ok && lo.reason === "below_minimum" && lo.minOrderCents === 10000 && lo.minQuantity === 33334, `33,333 ${cadence} → below_minimum ${JSON.stringify(lo)}`);
  const ok = pricing.quote({ leadType: BO, ageBandId: "bo-flat", quantity: 33334, billingCadence: cadence });
  check(ok.ok && ok.amountCents === 10001, `33,334 ${cadence} → $100.01 (${ok.amountCents})`);
}
for (const q of [1, 50, 100, 1000, 10000, 20000, 33000]) {
  check(pricing.quote({ leadType: BO, ageBandId: "bo-flat", quantity: q }).reason === "below_minimum", `${q} → below_minimum`);
}

// Rounding for custom quantities: always up to the next whole cent.
const ROUNDING = [[33334, 10001], [33335, 10001], [33336, 10001], [33337, 10002], [40001, 12001], [123457, 37038], [999999, 300000], [1000000, 300000]];
for (const [q, cents] of ROUNDING) {
  const r = pricing.quote({ leadType: BO, ageBandId: "bo-flat", quantity: q });
  check(r.ok && r.amountCents === cents, `rounding ${q} → ${r.amountCents} (want ${cents})`);
}
for (let q = 1; q <= pricing.maxQtyFor(BO); q++) {
  const c = pricing.amountCentsFor(boBands[0], q);
  // never under the exact price, never a full cent over
  if (!(c * 10 >= 3 * q && c * 10 - 3 * q < 10)) assert.fail(`rounding bound broken at ${q}: ${c}`);
  if (pricing.meetsProductMinimum(BO, boBands[0], q) !== q >= 33334) assert.fail(`minimum boundary broken at ${q}`);
}
passed++;

// Max cap
check(pricing.quote({ leadType: BO, ageBandId: "bo-flat", quantity: 1000000 }).ok, "1,000,000 OK");
check(pricing.quote({ leadType: BO, ageBandId: "bo-flat", quantity: 1000001 }).reason === "invalid_quantity", "1,000,001 → invalid_quantity");
check(pricing.quote({ leadType: "general-life", ageBandId: "lm-365", quantity: 100001 }).reason === "invalid_quantity", "Life still capped at 100,000");
check(pricing.quote({ leadType: "private-health", ageBandId: "ph-365", quantity: 250000 }).reason === "invalid_quantity", "Private Health 250,000 still rejected");

// Band handling: missing / "n/a" band OK for flat products only; wrong bands rejected.
for (const ageBandId of [undefined, null, "", "n/a"]) {
  const r = pricing.quote({ leadType: BO, ageBandId, quantity: 50000 });
  check(r.ok && r.ageBandId === "bo-flat" && r.amountCents === 15000, `BO with band ${JSON.stringify(ageBandId)}`);
}
for (const [leadType, ageBandId] of [[BO, "lm-u30"], [BO, "ph-365"], [BO, "toString"], ["general-life", "bo-flat"], ["private-health", "bo-flat"], ["general-life", undefined], ["general-life", "n/a"]]) {
  const r = pricing.quote({ leadType, ageBandId, quantity: 50000 });
  check(!r.ok && (r.reason === "invalid_age_band" || r.reason === "invalid_quantity"), `${leadType}/${ageBandId} rejected`);
  const r2 = pricing.quote({ leadType, ageBandId, quantity: 1000 });
  if (leadType !== BO) check(!r2.ok && r2.reason === "invalid_age_band", `${leadType}/${ageBandId} → invalid_age_band`);
}

// ——— 3. create-checkout handler (stubbed Stripe) ———
async function handlerTests() {
  const stripeClient = require(path.join(ROOT, "netlify/functions/lib/stripe-client.js"));
  const created = [];
  stripeClient.stripeConfigured = () => true;
  stripeClient.getStripe = () => ({
    checkout: { sessions: { create: async (p) => (created.push(p), { id: "cs_test_bo_" + created.length, url: "https://checkout.stripe.test/bo" }) } },
  });
  const { handler } = require(path.join(ROOT, "netlify/functions/create-checkout.js"));
  const call = async (body) => {
    const res = await handler({ httpMethod: "POST", headers: { host: "localhost:8888", "x-forwarded-proto": "http" }, body: JSON.stringify(body) });
    return { status: res.statusCode, data: JSON.parse(res.body) };
  };
  const base = {
    leadType: BO, leadTypeLabel: "Business Owner Raw Data", ageBandId: "bo-flat", ageBandLabel: "No age band (flat rate)",
    quantity: 50000, states: ["FL", "GA"], billingCadence: "one-time", email: "owner-buyer@example.com",
    contactMethods: ["Dialer"], contactOther: "", unitPrice: 0.003,
  };

  for (const q of BO_PRESETS) {
    for (const cadence of CADENCES) {
      const want = BO_PRESET_CENTS[q];
      const r = await call({ ...base, quantity: q, billingCadence: cadence });
      check(r.status === 200 && r.data.ok, `${q} ${cadence}: ${JSON.stringify(r.data)}`);
      const s = created.at(-1);
      const li = s.line_items[0];
      check(li.quantity === 1 && li.price_data.unit_amount === want && Number.isInteger(li.price_data.unit_amount), `${q} ${cadence}: unit_amount ${li.price_data.unit_amount}`);
      check(li.price_data.currency === "usd" && !("unit_amount_decimal" in li.price_data), "integer cents line");
      check(s.mode === (cadence === "one-time" ? "payment" : "subscription"), `${cadence} mode`);
      if (cadence === "one-time") check(!li.price_data.recurring && !s.subscription_data, "no recurring for one-time");
      else check(li.price_data.recurring.interval === (cadence === "weekly" ? "week" : "month"), `${cadence} interval`);
      const m = s.metadata;
      check(m.leadType === BO && m.leadTypeLabel === "Business Owner Raw Data" && m.ageBandId === "bo-flat" && m.ageBandLabel === "No age band (flat rate)", "metadata lead type / band");
      check(m.quantity === String(q) && m.unitPrice === "0.003" && m.unitPriceCents === "0.3" && m.amountCents === String(want) && m.pricing === "server", `metadata pricing ${JSON.stringify(m)}`);
      check(m.billingCadence === cadence && m.states === "FL,GA", "metadata cadence / states");
      check(!Object.keys(m).some((k) => /^terms/.test(k)) && !(s.subscription_data && Object.keys(s.subscription_data.metadata).some((k) => /^terms/.test(k))), "no terms fields in metadata (terms work on hold)");
      check(li.price_data.product_data.name === "Lead Reload HQ — Business Owner Raw Data ($0.003 per record)", `product name ${li.price_data.product_data.name}`);
      check(li.price_data.product_data.description.startsWith(`${q.toLocaleString("en-US")} records · FL,GA`), `description ${li.price_data.product_data.description}`);
      if (cadence !== "one-time") {
        const sm = s.subscription_data.metadata;
        check(sm.leadType === BO && sm.amountCents === String(want) && sm.quantity === String(q) && sm.billingCadence === cadence, "subscription_data.metadata (renewals) carry the lead type");
      }
    }
  }

  // $100 minimum at the server, every cadence: 33,333 rejected, 33,334 accepted.
  for (const cadence of CADENCES) {
    const n = created.length;
    let r = await call({ ...base, quantity: 33333, billingCadence: cadence });
    check(r.status === 400 && r.data.ok === false && r.data.reason === "below_minimum" && r.data.minOrderCents === 10000 && r.data.minQuantity === 33334, `33,333 ${cadence}: ${r.status} ${JSON.stringify(r.data)}`);
    check(created.length === n, `33,333 ${cadence}: no Stripe session`);
    // Tampered price on a below-minimum cart doesn't help either.
    r = await call({ ...base, quantity: 33333, billingCadence: cadence, unitPrice: 1, amountCents: 20000 });
    check(r.status === 400 && r.data.reason === "below_minimum" && created.length === n, "tampered below-minimum still 400");
    r = await call({ ...base, quantity: 33334, billingCadence: cadence });
    check(r.status === 200 && created.at(-1).line_items[0].price_data.unit_amount === 10001, `33,334 ${cadence} → $100.01`);
  }

  // Tampered client prices / totals / labels are ignored.
  for (const tamper of [
    { unitPrice: 0 }, { unitPrice: 0.0000001 }, { unitPrice: 0.002 }, { unitPrice: -1 }, { unitPrice: 5 }, { unitPrice: "0.000" },
    { amountCents: 1 }, { amount: "0.01" }, { total: 0.01 }, { unit_amount: 1 }, { price: 0 }, { unitMills: 0 },
    { minOrderCents: 0 }, { leadTypeLabel: "FREE", ageBandLabel: "<b>x</b>" },
  ]) {
    const r = await call({ ...base, quantity: 50000, ...tamper });
    const s = created.at(-1);
    check(r.status === 200 && s.line_items[0].price_data.unit_amount === 15000 && s.metadata.unitPrice === "0.003", `tampered ${JSON.stringify(tamper)} → still $150.00`);
    check(s.metadata.leadTypeLabel === "Business Owner Raw Data" && s.metadata.ageBandLabel === "No age band (flat rate)", "server labels");
  }
  // Missing / n/a band accepted for Business Owner; custom qty rounded; cap.
  let r = await call({ ...base, ageBandId: undefined, quantity: 35000, billingCadence: "monthly" });
  check(r.status === 200 && created.at(-1).line_items[0].price_data.unit_amount === 10500 && created.at(-1).metadata.ageBandId === "bo-flat", "no ageBandId → bo-flat");
  r = await call({ ...base, quantity: 40001 });
  check(r.status === 200 && created.at(-1).line_items[0].price_data.unit_amount === 12001, "40,001 records → $120.01 (rounded up from $120.003)");
  r = await call({ ...base, quantity: 1000000, billingCadence: "weekly" });
  check(r.status === 200 && created.at(-1).line_items[0].price_data.unit_amount === 300000, "1,000,000 records → $3,000.00 (BO max)");
  r = await call({ ...base, quantity: 500000 });
  check(r.status === 200 && created.at(-1).line_items[0].price_data.unit_amount === 150000, "500,000 records → $1,500.00");
  // Terms work is on hold: a request without any terms fields is accepted.
  r = await call({ ...base, quantity: 35000 });
  check(r.status === 200 && created.at(-1).line_items[0].price_data.unit_amount === 10500, "no terms fields required");
  const n = created.length;
  for (const [body, reason] of [
    [{ ...base, ageBandId: "lm-u30" }, "invalid_age_band"],
    [{ ...base, ageBandId: "ph-u30" }, "invalid_age_band"],
    [{ ...base, leadType: "general-life", ageBandId: "bo-flat", quantity: 1000 }, "invalid_age_band"],
    [{ ...base, leadType: "general-life", ageBandId: undefined, quantity: 1000 }, "invalid_cart"],
    [{ ...base, leadType: "business_owner" }, "invalid_lead_type"],
    [{ ...base, quantity: 1000 }, "below_minimum"],
    [{ ...base, quantity: 1 }, "below_minimum"],
    [{ ...base, quantity: 1000001 }, "invalid_quantity"],
    [{ ...base, quantity: 50000.5 }, "invalid_quantity"],
    [{ ...base, states: [] }, "invalid_states"],
    [{ ...base, billingCadence: "daily" }, "invalid_cadence"],
    // Other products keep their 100,000 cap and the $0.50 minimum.
    [{ ...base, leadType: "general-life", ageBandId: "lm-365", quantity: 100001 }, "invalid_quantity"],
    [{ ...base, leadType: "private-health", ageBandId: "ph-365", quantity: 250000 }, "invalid_quantity"],
    [{ ...base, leadType: "private-health", ageBandId: "ph-365", quantity: 16 }, "amount_too_small"],
  ]) {
    r = await call(body);
    check(r.status === 400 && r.data.reason === reason, `expected 400 ${reason}, got ${r.status} ${JSON.stringify(r.data)}`);
  }
  check(created.length === n, "no session for rejected carts");
  // Other products at small quantities are not hit by the Business Owner minimum.
  r = await call({ ...base, leadType: "general-life", ageBandId: "lm-365", quantity: 50 });
  check(r.status === 200 && created.at(-1).line_items[0].price_data.unit_amount === 150, "Life 50 × $0.03 = $1.50 still accepted");
}

// ——— 4. Storefront (app.js in a vm, tiny fake DOM) ———
function makeEl(id, extra = {}) {
  const listeners = {};
  const cls = new Set(extra.initialClasses || []);
  const attrs = {};
  return Object.assign({
    id, textContent: "", innerHTML: "", value: "", disabled: false, hidden: false, checked: false, title: "", dataset: {}, offsetWidth: 0, attrs,
    classList: {
      add: (...c) => c.forEach((x) => cls.add(x)), remove: (...c) => c.forEach((x) => cls.delete(x)),
      toggle: (c, f) => { const on = f === undefined ? !cls.has(c) : !!f; if (on) cls.add(c); else cls.delete(c); return on; },
      contains: (c) => cls.has(c),
    },
    setAttribute(k, v) { attrs[k] = String(v); }, querySelectorAll: () => [],
    addEventListener(t, fn) { (listeners[t] = listeners[t] || []).push(fn); },
    dispatchEvent(e) { return (listeners[e.type] || []).map((fn) => fn(e)); },
    async fire(t) { await Promise.all((listeners[t] || []).map((fn) => fn({ type: t }))); },
  }, extra);
}
async function boot(draft) {
  const els = {};
  const el = (id) => (els[id] = els[id] || makeEl(id));
  const chipsDefault = DEFAULT_PRESETS.map((q) => makeEl("chip-" + q, { dataset: { qty: String(q) } }));
  const chipsBo = BO_PRESETS.map((q) => makeEl("chip-bo-" + q, { dataset: { qty: String(q) } }));
  const groups = [
    makeEl("presets-default", { dataset: { presets: "default" } }),
    makeEl("presets-bo", { dataset: { presets: "business-owner" }, initialClasses: ["hidden"] }),
  ];
  const typeRadios = ["general-life", "mortgage-protection", "private-health", BO].map((v) => makeEl("type-" + v, { value: v }));
  const store = { "lead-reload-draft": JSON.stringify(draft) };
  const calls = [];
  const contactBox = { value: "Dialer", checked: true };
  const sandbox = {
    window: { location: { search: "", pathname: "/", href: "/" }, history: { replaceState() {} }, matchMedia: () => ({ matches: false }), addEventListener() {}, scrollTo() {} },
    document: {
      readyState: "complete", body: { classList: makeEl("body").classList }, getElementById: el, querySelector: () => null, addEventListener() {},
      querySelectorAll: (sel) =>
        sel === ".chip-btn[data-qty]" ? [...chipsDefault, ...chipsBo]
        : sel === ".qty-presets[data-presets]" ? groups
        : sel === 'input[name="leadType"]' ? typeRadios
        : sel === 'input[name="contactMethod"]:checked' ? [contactBox] : [],
    },
    fetch: async (url, opts) => {
      const body = JSON.parse(opts.body);
      calls.push(body);
      return { json: async () => (body.probe ? { ok: true, configured: true } : { ok: true, url: "https://checkout.stripe.test/bo", sessionId: "cs_bo" }) };
    },
    localStorage: { getItem: (k) => (k in store ? store[k] : null), setItem: (k, v) => (store[k] = String(v)), removeItem: (k) => delete store[k] },
    requestAnimationFrame: () => 0, setTimeout, clearTimeout, URLSearchParams, console,
    Event: class { constructor(t) { this.type = t; } },
  };
  vm.runInNewContext(APP_SRC, sandbox, { filename: "public/app.js" });
  await new Promise((r) => setImmediate(r));
  const typeRadio = (v) => typeRadios.find((r) => r.value === v);
  const boVisible = () => !groups[1].classList.contains("hidden") && groups[0].classList.contains("hidden");
  const defaultVisible = () => !groups[0].classList.contains("hidden") && groups[1].classList.contains("hidden");
  return { el, chipsDefault, chipsBo, groups, boVisible, defaultVisible, typeRadio, calls, store, window: sandbox.window, draft: () => JSON.parse(store["lead-reload-draft"] || "null") };
}
async function typeQty(env, v) {
  env.el("quantity").value = String(v);
  await env.el("quantity").fire("input");
}

async function storefrontTests() {
  const baseDraft = { leadType: BO, ageBandId: null, quantity: 50000, states: ["FL", "GA"], billingCadence: "one-time", contactMethods: ["Dialer"], contactOther: "" };

  // A saved Business Owner cart on the Age step jumps to Quantity with the flat band.
  let env = await boot({ ...baseDraft, step: 2 });
  check(env.draft().step === 3 && env.draft().ageBandId === "bo-flat", `BO draft on Age step → ${JSON.stringify(env.draft())}`);
  check(env.el("prev-age").textContent === "No age band (flat rate)" && env.el("prev-unit").textContent === "$0.003 ($30 per 10k)", "preview: no age band, $0.003 ($30 per 10k)");
  check(env.el("qty-unit-price").textContent === "$0.003 ($30 per 10k)" && env.el("qty-est-total").textContent === "$150.00", "qty step: $0.003 ($30 per 10k) / $150.00");
  check(!env.el("qty-flat-note").classList.contains("hidden") && env.el("qty-volume-callout").classList.contains("hidden"), "BO note shown, lead volume callout hidden");
  check(env.boVisible(), "Business Owner preset group shown, default group hidden");
  check(env.el("quantity").attrs.min === "33334" && env.el("quantity").attrs.max === "1000000", `qty input min/max ${JSON.stringify(env.el("quantity").attrs)}`);
  check(env.chipsBo.find((c) => c.dataset.qty === "50000").classList.contains("active"), "50,000 chip active");
  check([...env.chipsDefault, ...env.chipsBo].every((c) => !c.disabled), "no preset is disabled");
  check(env.el("btn-next").disabled === false && env.el("qty-min-note").classList.contains("hidden"), "50,000: Continue enabled, no minimum note");
  // Back from Quantity skips Age.
  await env.el("btn-back").fire("click");
  check(env.draft().step === 1, "Back from Qty → Type (Age skipped)");
  await env.el("btn-next").fire("click");
  check(env.draft().step === 3, "Continue from Type → Qty (Age skipped)");

  // Every preset chip gives the right estimate.
  for (const c of env.chipsBo) {
    await c.fire("click");
    check(env.el("qty-est-total").textContent === "$" + (BO_PRESET_CENTS[c.dataset.qty] / 100).toFixed(2) + "", `chip ${c.dataset.qty}: ${env.el("qty-est-total").textContent}`);
    check(env.el("btn-next").disabled === false, `chip ${c.dataset.qty}: Continue enabled`);
  }

  // Custom quantities under the minimum: Continue disabled + message; 33,334 enables it.
  for (const v of [33333, 20000, 1000]) {
    await typeQty(env, v);
    check(env.el("btn-next").disabled === true, `${v} records: Continue disabled`);
    check(env.el("qty-min-note").textContent === BO_MIN_MSG && !env.el("qty-min-note").classList.contains("hidden"), `min note: ${env.el("qty-min-note").textContent}`);
    const step = env.draft().step;
    await env.el("btn-next").fire("click");
    check(env.draft().step === step, `${v}: clicking Continue does not advance`);
  }
  await typeQty(env, 33334);
  check(env.el("btn-next").disabled === false && env.el("qty-min-note").classList.contains("hidden") && env.el("qty-est-total").textContent === "$100.01", "33,334: Continue enabled, $100.01");
  await typeQty(env, 250000);
  check(env.el("qty-est-total").textContent === "$750.00" && env.el("btn-next").disabled === false, "250,000 custom OK");
  await typeQty(env, 5000000);
  check(env.draft().quantity === 1000000 && env.el("qty-est-total").textContent === "$3000.00", `typing 5,000,000 caps at 1,000,000 (${env.draft().quantity})`);

  // Saved Business Owner cart under the minimum on Review is sent back to Quantity.
  env = await boot({ ...baseDraft, ageBandId: "bo-flat", step: 5, quantity: 10000 });
  check(env.draft().step === 3 && env.el("btn-next").disabled === true && env.el("qty-min-note").textContent === BO_MIN_MSG, "under-minimum draft on Review → back to Quantity, Continue disabled");
  check(env.el("pay-btn").disabled === true, "Pay disabled under the minimum");
  await env.el("pay-btn").fire("click");
  check(env.calls.filter((c) => !c.probe).length === 0, "no create-checkout call under the minimum");

  // Switching to Business Owner from a small Life cart bumps the quantity to 35,000;
  // switching back keeps presets per product and caps at 100,000.
  env = await boot({ ...baseDraft, leadType: "general-life", ageBandId: "lm-365", step: 1, quantity: 100 });
  check(env.defaultVisible(), "Life: default presets visible");
  check(env.el("quantity").attrs.max === "100000" && env.el("quantity").attrs.min === "1", "Life: input 1..100,000");
  env.typeRadio(BO).checked = true;
  await env.typeRadio(BO).fire("change");
  check(env.draft().leadType === BO && env.draft().quantity === 35000 && env.draft().ageBandId === "bo-flat", `→ BO: ${JSON.stringify(env.draft())}`);
  check(env.boVisible() && env.el("quantity").value === 35000, "BO presets shown, qty 35,000");
  await typeQty(env, 250000);
  env.typeRadio("private-health").checked = true;
  await env.typeRadio("private-health").fire("change");
  check(env.draft().quantity === 100000 && env.defaultVisible(), `→ Private Health: qty capped to 100,000 (${env.draft().quantity}), default presets`);

  // Life products are unaffected by the Business Owner minimum and keep the Age step.
  env = await boot({ ...baseDraft, leadType: "general-life", ageBandId: "lm-365", step: 3, quantity: 50 });
  check(env.el("btn-next").disabled === false && env.el("qty-min-note").classList.contains("hidden"), "Life 50 × $0.03: Continue enabled");
  check(!env.el("qty-volume-callout").classList.contains("hidden") && env.el("qty-flat-note").classList.contains("hidden"), "Life: volume callout shown, BO note hidden");
  check(env.el("prev-unit").textContent === "$0.03" && env.el("qty-unit-price").textContent === "$0.03", "Life unit price has no per-10k label");
  await typeQty(env, 16);
  check(env.el("btn-next").disabled === true && env.el("qty-min-note").textContent === "Minimum order is $0.50: at least 17 leads at this price.", `Life $0.50 minimum unchanged: ${env.el("qty-min-note").textContent}`);
  await env.el("btn-back").fire("click");
  check(env.draft().step === 2, "Life: Back from Qty → Age");

  // Checkout payload for each preset/cadence; review summary shows $0.003 / record ($30 per 10k) and the $100 minimum.
  for (const [q, cents] of table) {
    for (const cadence of CADENCES) {
      env = await boot({ ...baseDraft, ageBandId: "bo-flat", step: 5, quantity: q, billingCadence: cadence });
      const want = "$" + (cents / 100).toFixed(2);
      check(env.el("pay-btn").innerHTML.includes(want), `${q} ${cadence}: pay label ${env.el("pay-btn").innerHTML}`);
      const review = env.el("review-summary").innerHTML;
      check(review.includes("$0.003 / record ($30 per 10k)") && review.includes("$100.00 minimum order"), `review summary pricing: ${review.replace(/\s+/g, " ")}`);
      env.el("pay-email").value = "owner-buyer@example.com";
      check(env.el("pay-btn").disabled === false, "Pay enabled at/above the minimum");
      await env.el("pay-btn").fire("click");
      const body = env.calls.at(-1);
      check(body.leadType === BO && body.ageBandId === "bo-flat" && body.quantity === q && body.billingCadence === cadence, `${q} ${cadence}: payload`);
      check(!("termsAccepted" in body) && !("termsVersion" in body), "payload has no terms fields");
    }
  }
  // No terms checkbox on this release: Pay is enabled as soon as Stripe is live
  // and the cart meets the minimum.
  env = await boot({ ...baseDraft, ageBandId: "bo-flat", step: 6, quantity: 50000 });
  check(env.el("pay-btn").disabled === false, "Pay enabled at 50,000 (no terms box)");
  check(!/terms-accept|terms-check|href="\/terms\/"/.test(HTML), "index.html has no terms checkbox or /terms/ link");
  check(!/TERMS_VERSION|termsAccepted/.test(APP_SRC), "app.js sends no terms fields");
}

// ——— 5. Banned wording in the new copy ———
function copyTests() {
  const BANNED = /exclusiv|opt-?in|opted|consent|permission|tcpa|verified|\bfresh\b|\bIP\b|ip address|ip data|form data/i;
  const card = (HTML.match(/<input type="radio" name="leadType" value="business-owner" \/>[\s\S]*?<\/label>/) || [""])[0];
  check(card.includes("Business Owner Raw Data") && card.includes("$0.003/record ($30 per 10k)"), "type card: per-record price");
  check(/<p class="type-min-badge">\$100 minimum<\/p>/.test(card), "type card: $100 minimum");
  const snippets = [
    ["type card", card.replace(/<[^>]+>/g, " ")],
    ["qty flat note", (HTML.match(/<p class="qty-flat-note[^>]*>([\s\S]*?)<\/p>/) || [])[1]],
  ];
  for (const m of APP_SRC.matchAll(/"([^"]*(?:Business Owner|Minimum order is \$0\.50: at least|No age band|minimum order|per 10k)[^"]*)"/g)) snippets.push(["app.js", m[1]]);
  check(snippets.length >= 8, `new copy snippets found: ${snippets.length}`);
  for (const [where, s] of snippets) {
    check(typeof s === "string" && s.trim().length > 0, `${where} present`);
    check(!BANNED.test(s), `${where}: banned wording in "${s}"`);
  }
  // Whole storefront + admin stay clean of the live-copy-check pattern.
  const LIVE = /exclusiv|opt-?in|opted|consent|permission|tcpa|verified|fresh opt/i;
  for (const f of ["public/index.html", "public/app.js", "public/styles.css", "public/admin/index.html", "public/admin/admin.js", "public/admin/orders-view.js"]) {
    check(!LIVE.test(fs.readFileSync(path.join(ROOT, f), "utf8")), `${f} clean`);
    check(!/ip address|ip data|form data/i.test(fs.readFileSync(path.join(ROOT, f), "utf8")), `${f}: no IP / form data mention`);
  }
}

(async () => {
  await handlerTests();
  await storefrontTests();
  copyTests();
  console.log("Business Owner Raw Data — $0.003 / record ($30 per 10k), server-priced, $100 minimum (same for one-time, weekly, monthly):");
  for (const [q, cents] of table) {
    console.log(`  ${q.toLocaleString("en-US").padStart(7)} records  $${(cents / 100).toFixed(2)}`);
  }
  console.log("  33,333 records ($99.999) → 400 below_minimum; 33,334 → $100.01 (rounded up from $100.002).");
  console.log("  Custom quantities round UP to the next whole cent, e.g. 40,001 → $120.01. Max 1,000,000 records ($3,000.00).");
  console.log(`PASS — business owner pricing + minimum + storefront + copy: ${passed} assertions`);
})().catch((err) => {
  console.error("FAIL:", err && err.message ? err.message : err);
  process.exit(1);
});

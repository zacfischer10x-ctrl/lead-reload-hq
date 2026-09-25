#!/usr/bin/env node
/* eslint-disable no-console */
"use strict";

/**
 * Pricing parity + create-checkout tests. No dependencies, no network.
 *
 *   node scripts/test-pricing.js      (or: npm run test:pricing)
 *
 * 1. Loads the REAL pricing code from public/app.js (the block from
 *    `const LEAD_TYPES` down to the "Render helpers" marker: price tables,
 *    state, unitPrice(), orderTotal(), money(), formatCadenceTotal()) into a
 *    sandbox and drives it like the wizard does.
 * 2. For every lead type × age band, every quantity 1..100,000 and every
 *    billing cadence, asserts the server table (netlify/functions/lib/pricing.js)
 *    produces exactly the total the storefront displays.
 * 3. Calls the create-checkout handler with a stubbed Stripe client to prove
 *    the client-sent unitPrice is ignored and bad combos get a 400.
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

// ——— 1. Load frontend pricing code from public/app.js ———
function loadFrontendPricing() {
  const src = fs.readFileSync(path.join(ROOT, "public/app.js"), "utf8");
  const startMarker = "const LEAD_TYPES = {";
  const endMarker = "// ——— Render helpers ———";
  const start = src.indexOf(startMarker);
  const end = src.indexOf(endMarker);
  if (start < 0 || end < 0 || end <= start) {
    throw new Error(
      "Could not find pricing block in public/app.js (markers moved?). Update scripts/test-pricing.js."
    );
  }
  const block = src.slice(start, end);
  const code =
    '"use strict";\n' +
    block +
    "\n;({ LEAD_TYPES, PRICING, BILLING_OPTIONS, MAX_QTY, MIN_ORDER_CENTS, state, getBands, getSelectedBand, unitPrice, orderTotal, money, formatCadenceTotal });";
  // localStorage/document are only touched by functions we never call.
  return vm.runInNewContext(code, {}, { filename: "public/app.js#pricing-block" });
}

const fe = loadFrontendPricing();

// ——— 2. Table + parity checks ———
const feTypeIds = Object.keys(fe.LEAD_TYPES).sort();
const beTypeIds = Object.keys(pricing.LEAD_TYPES).sort();
check(
  JSON.stringify(feTypeIds) === JSON.stringify(beTypeIds),
  `lead type ids differ: frontend ${feTypeIds} vs server ${beTypeIds}`
);
check(
  JSON.stringify(Object.keys(fe.BILLING_OPTIONS).sort()) ===
    JSON.stringify(Object.keys(pricing.BILLING_CADENCES).sort()),
  "billing cadence ids differ"
);
check(fe.MAX_QTY === pricing.MAX_QTY, `MAX_QTY differs: ${fe.MAX_QTY} vs ${pricing.MAX_QTY}`);
check(
  fe.MIN_ORDER_CENTS === pricing.MIN_AMOUNT_CENTS,
  `minimum order differs: frontend ${fe.MIN_ORDER_CENTS} vs server ${pricing.MIN_AMOUNT_CENTS}`
);

const rows = [];
let comboCount = 0;
let qtyChecks = 0;
const belowMinimum = [];

for (const typeId of feTypeIds) {
  const feType = fe.LEAD_TYPES[typeId];
  const beType = pricing.LEAD_TYPES[typeId];
  check(feType.label === beType.label, `label differs for ${typeId}`);
  check(feType.pricingKey === beType.pricingKey, `pricingKey differs for ${typeId}`);

  fe.state.leadType = typeId;
  const feBands = fe.getBands();
  const beBands = pricing.PRICE_TABLES[beType.pricingKey];
  check(
    JSON.stringify(feBands.map((b) => b.id)) === JSON.stringify(beBands.map((b) => b.id)),
    `age band ids differ for ${typeId}`
  );

  for (const feBand of feBands) {
    comboCount++;
    fe.state.ageBandId = feBand.id;
    const beBand = pricing.getBand(typeId, feBand.id);
    check(!!beBand, `server missing ${typeId}/${feBand.id}`);
    check(beBand.label === feBand.label, `band label differs ${typeId}/${feBand.id}`);
    check(
      fe.money(fe.unitPrice()) === "$" + pricing.centsToDollarString(beBand.unitCents),
      `unit price differs ${typeId}/${feBand.id}: ${fe.money(fe.unitPrice())} vs ${beBand.unitCents}c`
    );
    rows.push([beType.label, feBand.id, feBand.label, fe.money(fe.unitPrice())]);

    let firstChargeable = null;
    for (let q = 1; q <= pricing.MAX_QTY; q++) {
      fe.state.quantity = q;
      fe.state.billingCadence = "one-time";
      const shown = fe.money(fe.orderTotal());
      const quoted = pricing.quote({ leadType: typeId, ageBandId: feBand.id, quantity: q, billingCadence: "one-time" });
      const expectedCents = beBand.unitCents * q;
      // Displayed total must equal server cents regardless of whether Stripe accepts it.
      assert.strictEqual(shown, "$" + pricing.centsToDollarString(expectedCents), `display mismatch ${typeId}/${feBand.id} q=${q}`);
      // Legacy server math (Math.round(unit × qty × 100)) must equal the new integer math.
      assert.strictEqual(Math.round(fe.unitPrice() * q * 100), expectedCents, `legacy cents mismatch ${typeId}/${feBand.id} q=${q}`);
      if (expectedCents < pricing.MIN_AMOUNT_CENTS) {
        assert.strictEqual(quoted.ok, false);
        assert.strictEqual(quoted.reason, "amount_too_small");
      } else {
        if (firstChargeable === null) firstChargeable = q;
        assert.strictEqual(quoted.ok, true, `quote failed ${typeId}/${feBand.id} q=${q}: ${quoted.reason}`);
        assert.strictEqual(quoted.amountCents, expectedCents);
      }
      qtyChecks++;
    }
    if (firstChargeable > 1) {
      belowMinimum.push(`${typeId}/${feBand.id} (${fe.money(fe.unitPrice())}): qty ${firstChargeable === 2 ? "1" : "1–" + (firstChargeable - 1)} → amount_too_small`);
    }

    // Cadence: same total per bill, correct Stripe mode/interval, same display.
    for (const q of [1, 17, 50, 100, 250, 999, 1000, 2500, 5000, 10000, 33333, 100000]) {
      for (const cadence of Object.keys(pricing.BILLING_CADENCES)) {
        fe.state.quantity = q;
        fe.state.billingCadence = cadence;
        const quoted = pricing.quote({ leadType: typeId, ageBandId: feBand.id, quantity: q, billingCadence: cadence });
        const expectedCents = beBand.unitCents * q;
        if (expectedCents < pricing.MIN_AMOUNT_CENTS) {
          check(!quoted.ok && quoted.reason === "amount_too_small", "min amount");
          continue;
        }
        check(quoted.ok, `quote failed ${cadence}`);
        const suffix = cadence === "one-time" ? " one-time" : cadence === "weekly" ? " / week" : " / month";
        check(
          fe.formatCadenceTotal(fe.orderTotal()) === "$" + quoted.amount + suffix,
          `cadence display mismatch ${typeId}/${feBand.id} q=${q} ${cadence}`
        );
        check(quoted.mode === (cadence === "one-time" ? "payment" : "subscription"), "mode");
        check(quoted.interval === { "one-time": null, weekly: "week", monthly: "month" }[cadence], "interval");
      }
    }
  }
}
passed += qtyChecks;

// Negative quote cases
for (const [input, reason] of [
  [{ leadType: "general-life", ageBandId: "ph-u30", quantity: 100 }, "invalid_age_band"],
  [{ leadType: "private-health", ageBandId: "lm-u30", quantity: 100 }, "invalid_age_band"],
  [{ leadType: "auto", ageBandId: "lm-u30", quantity: 100 }, "invalid_lead_type"],
  [{ leadType: "__proto__", ageBandId: "lm-u30", quantity: 100 }, "invalid_lead_type"],
  [{ leadType: "constructor", ageBandId: "lm-u30", quantity: 100 }, "invalid_lead_type"],
  [{ leadType: "general-life", ageBandId: "toString", quantity: 100 }, "invalid_age_band"],
  [{ leadType: "general-life", ageBandId: "lm-u30", quantity: 1.5 }, "invalid_quantity"],
  [{ leadType: "general-life", ageBandId: "lm-u30", quantity: 0 }, "invalid_quantity"],
  [{ leadType: "general-life", ageBandId: "lm-u30", quantity: 100001 }, "invalid_quantity"],
  [{ leadType: "general-life", ageBandId: "lm-u30", quantity: 100, billingCadence: "daily" }, "invalid_cadence"],
  [{ leadType: "general-life", ageBandId: "lm-u30", quantity: 100, billingCadence: "__proto__" }, "invalid_cadence"],
]) {
  const r = pricing.quote(input);
  check(!r.ok && r.reason === reason, `expected ${reason} for ${JSON.stringify(input)}, got ${JSON.stringify(r)}`);
}

// ——— 3. create-checkout handler with a stubbed Stripe client ———
async function handlerTests() {
  const stripeClient = require(path.join(ROOT, "netlify/functions/lib/stripe-client.js"));
  const created = [];
  stripeClient.stripeConfigured = () => true;
  stripeClient.getStripe = () => ({
    checkout: {
      sessions: {
        create: async (params) => {
          created.push(params);
          return { id: "cs_test_stub_" + created.length, url: "https://checkout.stripe.test/stub" };
        },
      },
    },
  });
  const { handler } = require(path.join(ROOT, "netlify/functions/create-checkout.js"));

  const call = async (body) => {
    const res = await handler({
      httpMethod: "POST",
      headers: { host: "localhost:8888", "x-forwarded-proto": "http" },
      body: JSON.stringify(body),
    });
    return { status: res.statusCode, data: JSON.parse(res.body) };
  };
  const base = {
    leadType: "general-life",
    leadTypeLabel: "General Life",
    ageBandId: "lm-u30",
    ageBandLabel: "Under 30 days",
    quantity: 10000,
    states: ["FL", "TX"],
    billingCadence: "one-time",
    email: "buyer@example.com",
    contactMethods: ["Dialer"],
    contactOther: "",
  };

  // Probe unchanged
  let r = await call({ probe: true });
  check(r.status === 200 && r.data.ok === true && r.data.configured === true, "probe");

  // Tampered unit price is ignored
  r = await call({ ...base, unitPrice: 0.0001 });
  check(r.status === 200 && r.data.ok, "tampered checkout should still succeed at server price");
  let s = created.at(-1);
  check(s.line_items[0].price_data.unit_amount === 520000, `expected 520000 cents, got ${s.line_items[0].price_data.unit_amount}`);
  check(s.mode === "payment", "one-time → payment");
  check(s.metadata.unitPrice === "0.52" && s.metadata.unitPriceCents === "52", "metadata unit price from server");
  check(s.metadata.amountCents === "520000" && s.metadata.pricing === "server", "metadata amount");

  // Honest request (what the storefront sends) gives the same result
  r = await call({ ...base, unitPrice: 0.52 });
  check(created.at(-1).line_items[0].price_data.unit_amount === 520000, "honest unitPrice");
  // Missing unitPrice is fine now
  r = await call({ ...base, unitPrice: undefined });
  check(r.status === 200 && created.at(-1).line_items[0].price_data.unit_amount === 520000, "missing unitPrice");

  // Fake labels are replaced with server labels
  r = await call({ ...base, leadTypeLabel: "FREE LEADS", ageBandLabel: "<script>" , ageBandId: "lm-365", leadType: "mortgage-protection", quantity: 5000 });
  s = created.at(-1);
  check(s.metadata.leadTypeLabel === "Mortgage Protection" && s.metadata.ageBandLabel === "365+ days", "server labels");
  check(s.line_items[0].price_data.product_data.name === "Lead Reload HQ — Mortgage Protection (365+ days)", "product name");
  check(s.line_items[0].price_data.unit_amount === 15000, "5000 × $0.03 = $150.00");

  // Weekly / monthly subscriptions, same amount per bill
  r = await call({ ...base, leadType: "private-health", ageBandId: "ph-90-180", quantity: 2500, billingCadence: "weekly" });
  s = created.at(-1);
  check(s.mode === "subscription" && s.line_items[0].price_data.recurring.interval === "week", "weekly");
  check(s.line_items[0].price_data.unit_amount === 32500 && s.subscription_data.metadata.amountCents === "32500", "weekly amount");
  r = await call({ ...base, leadType: "private-health", ageBandId: "ph-90-180", quantity: 2500, billingCadence: "monthly" });
  s = created.at(-1);
  check(s.line_items[0].price_data.recurring.interval === "month" && s.line_items[0].price_data.unit_amount === 32500, "monthly");

  // Rejections (no Stripe session created)
  const before = created.length;
  for (const [body, reason] of [
    [{ ...base, ageBandId: "ph-u30" }, "invalid_age_band"],
    [{ ...base, leadType: "private-health", ageBandId: "lm-90" }, "invalid_age_band"],
    [{ ...base, leadType: "free-leads" }, "invalid_lead_type"],
    [{ ...base, leadType: "__proto__" }, "invalid_lead_type"],
    [{ ...base, ageBandId: "does-not-exist" }, "invalid_age_band"],
    [{ ...base, quantity: 2.5 }, "invalid_quantity"],
    [{ ...base, quantity: 0 }, "invalid_quantity"],
    [{ ...base, quantity: 100001 }, "invalid_quantity"],
    [{ ...base, billingCadence: "daily" }, "invalid_cadence"],
    [{ ...base, states: [] }, "invalid_states"],
    [{ ...base, email: "nope" }, "invalid_cart"],
    [{ ...base, ageBandId: "lm-365", quantity: 16 }, "amount_too_small"],
  ]) {
    r = await call(body);
    check(r.status === 400 && r.data.ok === false && r.data.reason === reason, `expected 400 ${reason}, got ${r.status} ${JSON.stringify(r.data)}`);
  }
  check(created.length === before, "no Stripe session for rejected carts");
}

handlerTests()
  .then(() => {
    console.log("Price table (server = storefront):");
    for (const [type, id, label, price] of rows) {
      console.log(`  ${type.padEnd(20)} ${id.padEnd(11)} ${label.padEnd(14)} ${price} / lead`);
    }
    console.log(`\nCombos checked: ${comboCount} (lead type × age band)`);
    console.log(`Quantities checked per combo: 1..${pricing.MAX_QTY} (${qtyChecks.toLocaleString("en-US")} totals)`);
    console.log("Below Stripe $0.50 minimum (storefront shows a total, server returns 400 amount_too_small):");
    for (const b of belowMinimum) console.log("  " + b);
    console.log(`\nPASS — ${passed.toLocaleString("en-US")} assertions`);
  })
  .catch((err) => {
    console.error("FAIL:", err && err.message ? err.message : err);
    process.exit(1);
  });

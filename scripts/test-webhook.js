#!/usr/bin/env node
/* eslint-disable no-console */
"use strict";

/**
 * stripe-webhook signature enforcement tests. No network, no real keys:
 * uses placeholder strings and the Stripe SDK's own test-signature helper.
 * Netlify Blobs writes are stubbed so we can prove unverified events are
 * never stored.
 *
 *   node scripts/test-webhook.js      (or: npm run test:webhook)
 */

const path = require("path");
const assert = require("assert");

const ROOT = path.resolve(__dirname, "..");
const PLACEHOLDER_KEY = "unit-test-placeholder-not-a-stripe-key";
const PLACEHOLDER_SECRET = "unit-test-placeholder-webhook-secret";

process.env.STRIPE_SECRET_KEY = PLACEHOLDER_KEY;
delete process.env.STRIPE_WEBHOOK_SECRET;

// Stub Netlify Blobs before the webhook module destructures it.
const writes = [];
const blobs = require(path.join(ROOT, "netlify/functions/lib/blobs.js"));
const fakeStore = (name) => ({
  name,
  get: async () => null,
  setJSON: async (key, value) => writes.push({ store: name, key, value }),
});
blobs.ordersStore = () => fakeStore("orders");
blobs.subsStore = () => fakeStore("subs");
blobs.setJson = async (store, key, value) => store.setJSON(key, value);

const { handler } = require(path.join(ROOT, "netlify/functions/stripe-webhook.js"));
const { getStripe } = require(path.join(ROOT, "netlify/functions/lib/stripe-client.js"));
const stripe = getStripe();

// Keep expected rejection logs out of the test output.
const logged = [];
const realError = console.error;
console.error = (...args) => logged.push(args.join(" "));

let passed = 0;
function check(cond, msg) {
  assert.ok(cond, msg);
  passed++;
}

const payload = JSON.stringify({
  id: "evt_unit_test",
  object: "event",
  type: "checkout.session.completed",
  data: {
    object: {
      id: "cs_unit_test",
      object: "checkout.session",
      mode: "payment",
      amount_total: 5200,
      currency: "usd",
      created: 1790000000,
      customer_email: "buyer@example.com",
      metadata: { quantity: "100", billingCadence: "one-time" },
    },
  },
});

const sign = (body, secret = PLACEHOLDER_SECRET) =>
  stripe.webhooks.generateTestHeaderString({ payload: body, secret });

const post = (body, headers = {}, extra = {}) =>
  handler({ httpMethod: "POST", headers, body, ...extra });

(async () => {
  let r;

  // Secret missing → 503, even for signed or unsigned bodies; nothing stored.
  r = await post(payload, {});
  check(r.statusCode === 503 && r.body === "webhook_secret_not_configured", `no secret/unsigned → ${r.statusCode} ${r.body}`);
  r = await post(payload, { "stripe-signature": sign(payload) });
  check(r.statusCode === 503 && r.body === "webhook_secret_not_configured", `no secret/signed → ${r.statusCode} ${r.body}`);
  check(writes.length === 0, "no writes without secret");

  process.env.STRIPE_WEBHOOK_SECRET = PLACEHOLDER_SECRET;

  r = await handler({ httpMethod: "GET", headers: {}, body: "" });
  check(r.statusCode === 405, "GET → 405");

  r = await post(payload, {});
  check(r.statusCode === 400 && r.body === "missing_signature", `missing sig → ${r.statusCode} ${r.body}`);
  r = await post(payload, undefined);
  check(r.statusCode === 400 && r.body === "missing_signature", "undefined headers → 400");

  r = await post(payload, { "stripe-signature": "t=1,v1=deadbeef" });
  check(r.statusCode === 400 && r.body === "invalid_signature", `garbage sig → ${r.statusCode} ${r.body}`);

  r = await post(payload, { "stripe-signature": sign(payload, "some-other-secret") });
  check(r.statusCode === 400 && r.body === "invalid_signature", "wrong secret → 400");

  const tampered = payload.replace('"amount_total":5200', '"amount_total":1');
  r = await post(tampered, { "stripe-signature": sign(payload) });
  check(r.statusCode === 400 && r.body === "invalid_signature", "tampered body → 400");
  check(writes.length === 0, "no writes for any unverified event");

  // Valid signatures are processed.
  r = await post(payload, { "stripe-signature": sign(payload) });
  check(r.statusCode === 200 && r.body === "ok", `valid sig → ${r.statusCode} ${r.body}`);
  check(writes.length === 1 && writes[0].store === "orders" && writes[0].key === "cs_unit_test", "order stored");

  r = await post(payload, { "Stripe-Signature": sign(payload) });
  check(r.statusCode === 200, "mixed-case header accepted");

  r = await post(Buffer.from(payload).toString("base64"), { "stripe-signature": sign(payload) }, { isBase64Encoded: true });
  check(r.statusCode === 200, "base64 body accepted");
  check(writes.length === 3, "3 verified writes total");

  // Stripe key missing (secret present) → 503 stripe_not_configured.
  delete process.env.STRIPE_SECRET_KEY;
  r = await post(payload, { "stripe-signature": sign(payload) });
  check(r.statusCode === 503 && r.body === "stripe_not_configured", "no stripe key → 503");

  check(logged.some((l) => l.includes("signature verification failed")), "rejections are logged");
  console.log(`PASS — stripe-webhook: ${passed} assertions`);
})().catch((err) => {
  console.error = realError;
  console.error("FAIL:", err && err.message ? err.message : err);
  process.exit(1);
});

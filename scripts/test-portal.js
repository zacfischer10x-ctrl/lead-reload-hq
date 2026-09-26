#!/usr/bin/env node
/* eslint-disable no-console */
"use strict";

/**
 * create-portal must stay disabled: it never creates a Stripe session.
 *   node scripts/test-portal.js      (or: npm run test:portal)
 */

const path = require("path");
const assert = require("assert");

const ROOT = path.resolve(__dirname, "..");

// If anything tried to reach Stripe, this stub would record it.
const stripeClient = require(path.join(ROOT, "netlify/functions/lib/stripe-client.js"));
let stripeTouched = 0;
stripeClient.stripeConfigured = () => true;
stripeClient.getStripe = () => {
  stripeTouched++;
  throw new Error("create-portal must not use Stripe while disabled");
};

const { handler } = require(path.join(ROOT, "netlify/functions/create-portal.js"));

(async () => {
  let passed = 0;
  for (const req of [
    { httpMethod: "POST", headers: {}, body: JSON.stringify({ email: "victim@example.com" }) },
    { httpMethod: "POST", headers: {}, body: JSON.stringify({ customerId: "cus_123" }) },
    { httpMethod: "POST", headers: {}, body: "" },
    { httpMethod: "GET", headers: {}, body: "" },
  ]) {
    const res = await handler(req);
    const data = JSON.parse(res.body);
    assert.strictEqual(res.statusCode, 403, `${req.httpMethod} → ${res.statusCode}`);
    assert.deepStrictEqual(data, { ok: false, reason: "portal_disabled" });
    passed += 2;
  }
  const pre = await handler({ httpMethod: "OPTIONS", headers: {} });
  assert.strictEqual(pre.statusCode, 204);
  assert.strictEqual(stripeTouched, 0, "Stripe must not be called");
  passed += 2;
  console.log(`PASS — create-portal disabled: ${passed} assertions`);
})().catch((err) => {
  console.error("FAIL:", err && err.message ? err.message : err);
  process.exit(1);
});

#!/usr/bin/env node
/* eslint-disable no-console */
"use strict";

/**
 * Print the order confirmation without placing an order or calling Stripe.
 *
 *   node scripts/preview-order-email.js
 *   node scripts/preview-order-email.js --cadence weekly
 *   node scripts/preview-order-email.js --cadence monthly
 *   node scripts/preview-order-email.js --no-support
 *
 * Send one test message through the configured provider (needs the env vars
 * in ORDER_EMAIL.md). The subject is prefixed with [Test] and the body says
 * it is a test. No Stripe purchase.
 *
 *   node scripts/preview-order-email.js --send you@example.com
 */

const { buildOrderConfirmation, orderViewFromSession, SUBJECT } = require("../netlify/functions/lib/order-confirmation");
const { sendEmail, resolveEmailSettings } = require("../netlify/functions/lib/email");

function arg(name) {
  const i = process.argv.indexOf(name);
  if (i === -1) return "";
  return process.argv[i + 1] && !process.argv[i + 1].startsWith("--") ? process.argv[i + 1] : "";
}

const cadence = arg("--cadence") || "one-time";
const support = process.argv.includes("--no-support") ? "" : "support@leadreloadhq.com";
const amount = 130000;
const session = {
  id: "cs_preview_example",
  mode: cadence === "one-time" ? "payment" : "subscription",
  amount_total: amount,
  currency: "usd",
  created: Math.floor(Date.parse("2026-10-26T16:00:00.000Z") / 1000),
  customer_email: "buyer@example.com",
  metadata: {
    leadTypeLabel: "General Life",
    ageBandLabel: "Under 30 days",
    quantity: "2500",
    states: "FL,TX",
    billingCadence: cadence,
  },
};

const built = buildOrderConfirmation(orderViewFromSession(session, support));

async function main() {
  const sendTo = arg("--send");
  if (process.argv.includes("--send") && !sendTo) {
    console.error("Usage: node scripts/preview-order-email.js --send you@example.com");
    process.exit(1);
  }

  if (!sendTo) {
    console.log("Preview only. No email was sent.");
    console.log(`Cadence: ${cadence}`);
    if (support) {
      console.log(`Support address filled in for this preview: ${support}`);
      console.log("A real send uses ORDER_EMAIL_REPLY_TO (or the address in ORDER_EMAIL_FROM).");
    } else {
      console.log("Support address left blank so the contact placeholder is visible.");
    }
    console.log("");
    console.log(`SUBJECT: ${built.subject}`);
    console.log("");
    console.log(built.text);
    console.log("----- HTML -----");
    console.log(built.html);
    return;
  }

  const settings = resolveEmailSettings();
  if (!settings.configured) {
    console.error("Email is not configured. Missing: " + (settings.missing || []).join(", "));
    console.error("Set the env vars in ORDER_EMAIL.md, then run this command again. No email was sent.");
    process.exit(1);
  }

  const banner = "THIS IS A TEST MESSAGE. No order was placed.\n\n";
  const result = await sendEmail({
    to: sendTo,
    subject: `[Test] ${SUBJECT}`,
    text: banner + built.text,
    html: `<p><strong>THIS IS A TEST MESSAGE. No order was placed.</strong></p>${built.html}`,
    idempotencyKey: `order-confirmation-test:${Date.now()}`,
  });
  if (!result.ok) {
    console.error("Send failed.", result.reason || "", result.message || "");
    if (result.missing) console.error("Missing: " + result.missing.join(", "));
    process.exit(1);
  }
  console.log(`Sent a test message to ${sendTo}. Provider id: ${result.id || "(none)"}`);
  console.log("The subject starts with [Test]. The production subject is: " + SUBJECT);
}

main().catch((err) => {
  console.error(err && err.message ? err.message : err);
  process.exit(1);
});

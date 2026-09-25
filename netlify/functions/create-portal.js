"use strict";

/**
 * create-portal — DISABLED (2026-09-25).
 *
 * The previous version returned a Stripe Customer Portal session URL to anyone
 * who POSTed a customer's email address (or Stripe customer id). A portal
 * session lets the holder see invoices, change payment methods, and cancel
 * subscriptions, so that was an account-takeover hole. Nothing in the
 * storefront or admin UI calls this function, so it now always refuses.
 *
 * The file is kept so the function name/URL stays reserved
 * (/.netlify/functions/create-portal and /api/create-portal).
 *
 * To re-enable safely later, only mint a portal session for a customer the
 * caller has PROVEN they are, never from an email/customerId in the request:
 *   1. Admin-only: require a valid admin session
 *        const { requireAdmin } = require("./lib/auth");
 *        const auth = requireAdmin(event);
 *        if (!auth.ok) return json(auth.statusCode, { ok: false, reason: auth.error });
 *      then look up the Stripe customer id from our own stored order/sub record.
 *   2. Customer self-serve: email the customer a one-time magic link (or use
 *      Stripe's hosted customer-portal login link, configured in the Stripe
 *      Dashboard), and here accept only a short-lived HMAC-signed token that
 *      carries the Stripe customer id — never a raw email or customer id.
 *   Then call stripe.billingPortal.sessions.create({ customer, return_url })
 *   with return_url built from SITE_URL, and add tests for the auth check.
 */

const { json, options } = require("./lib/http");

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return options();
  return json(403, { ok: false, reason: "portal_disabled" });
};

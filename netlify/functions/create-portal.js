"use strict";

const { json, options, parseBody, siteUrl } = require("./lib/http");
const { getStripe, stripeConfigured } = require("./lib/stripe-client");

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return options();
  if (event.httpMethod !== "POST") {
    return json(405, { ok: false, reason: "method_not_allowed" });
  }
  if (!stripeConfigured()) {
    return json(200, { ok: false, reason: "stripe_not_configured" });
  }

  const { customerId, email } = parseBody(event);
  const stripe = getStripe();
  const origin = siteUrl(event);

  try {
    let custId = customerId;
    if (!custId && email) {
      const list = await stripe.customers.list({
        email: String(email).trim(),
        limit: 1,
      });
      if (list.data[0]) custId = list.data[0].id;
    }
    if (!custId) {
      return json(400, { ok: false, reason: "customer_not_found" });
    }
    const session = await stripe.billingPortal.sessions.create({
      customer: custId,
      return_url: `${origin}/`,
    });
    return json(200, { ok: true, url: session.url });
  } catch (err) {
    console.error("create-portal", err);
    return json(500, {
      ok: false,
      reason: "stripe_error",
      message: err.message,
    });
  }
};

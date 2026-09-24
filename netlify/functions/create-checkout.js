"use strict";

const { json, options, parseBody, siteUrl } = require("./lib/http");
const { getStripe, stripeConfigured } = require("./lib/stripe-client");

const MAX_QTY = 100000;
const ALLOWED = new Set(["one-time", "weekly", "monthly"]);

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return options();
  if (event.httpMethod !== "POST") {
    return json(405, { ok: false, reason: "method_not_allowed" });
  }

  const body = parseBody(event);

  // Frontend probe — confirm whether Stripe keys are live
  if (body.probe === true) {
    if (!stripeConfigured()) {
      return json(200, { ok: false, reason: "stripe_not_configured" });
    }
    return json(200, { ok: true, configured: true });
  }

  if (!stripeConfigured()) {
    return json(200, { ok: false, reason: "stripe_not_configured" });
  }

  const {
    leadType,
    leadTypeLabel,
    ageBandId,
    ageBandLabel,
    quantity,
    states,
    unitPrice,
    billingCadence = "one-time",
    email,
    contactMethods,
    contactOther,
  } = body;

  const qty = Number(quantity);
  const unit = Number(unitPrice);

  if (!leadType || !ageBandId || !email || !String(email).includes("@")) {
    return json(400, { ok: false, reason: "invalid_cart" });
  }
  if (!Number.isFinite(qty) || qty < 1 || qty > MAX_QTY) {
    return json(400, { ok: false, reason: "invalid_quantity" });
  }
  if (!Number.isFinite(unit) || unit <= 0) {
    return json(400, { ok: false, reason: "invalid_unit_price" });
  }
  if (!ALLOWED.has(billingCadence)) {
    return json(400, { ok: false, reason: "invalid_cadence" });
  }
  if (!Array.isArray(states) || states.length === 0) {
    return json(400, { ok: false, reason: "invalid_states" });
  }

  const amountCents = Math.round(unit * qty * 100);
  if (amountCents < 50) {
    return json(400, { ok: false, reason: "amount_too_small" });
  }

  const stripe = getStripe();
  const origin = siteUrl(event);
  const productName = `Lead Reload HQ — ${leadTypeLabel || leadType} (${ageBandLabel || ageBandId})`;
  const description = `${qty.toLocaleString("en-US")} leads · ${states.join(",")}`;

  const metadata = {
    leadType: String(leadType).slice(0, 64),
    leadTypeLabel: String(leadTypeLabel || leadType).slice(0, 64),
    ageBandId: String(ageBandId).slice(0, 64),
    ageBandLabel: String(ageBandLabel || "").slice(0, 64),
    quantity: String(qty),
    unitPrice: String(unit),
    billingCadence: String(billingCadence),
    states: states.join(",").slice(0, 450),
    contactMethods: Array.isArray(contactMethods)
      ? contactMethods.join(",").slice(0, 200)
      : "",
    contactOther: String(contactOther || "").slice(0, 120),
    source: "lead-reload-hq",
  };

  try {
    const sessionParams = {
      mode: billingCadence === "one-time" ? "payment" : "subscription",
      customer_email: String(email).trim().slice(0, 200),
      success_url: `${origin}/?checkout=success&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${origin}/?checkout=cancel`,
      metadata,
      line_items: [],
    };

    if (billingCadence === "one-time") {
      sessionParams.line_items = [
        {
          quantity: 1,
          price_data: {
            currency: "usd",
            unit_amount: amountCents,
            product_data: {
              name: productName,
              description,
              metadata: {
                leadType: metadata.leadType,
                ageBandId: metadata.ageBandId,
                quantity: metadata.quantity,
              },
            },
          },
        },
      ];
    } else {
      const interval = billingCadence === "weekly" ? "week" : "month";
      sessionParams.line_items = [
        {
          quantity: 1,
          price_data: {
            currency: "usd",
            unit_amount: amountCents,
            recurring: { interval },
            product_data: {
              name: productName,
              description: `${description} · ${billingCadence}`,
              metadata: {
                leadType: metadata.leadType,
                ageBandId: metadata.ageBandId,
                quantity: metadata.quantity,
              },
            },
          },
        },
      ];
      sessionParams.subscription_data = { metadata };
    }

    const session = await stripe.checkout.sessions.create(sessionParams);
    return json(200, { ok: true, url: session.url, sessionId: session.id });
  } catch (err) {
    console.error("create-checkout", err);
    return json(500, {
      ok: false,
      reason: "stripe_error",
      message: err.message || "checkout_failed",
    });
  }
};

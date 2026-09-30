"use strict";

const { json, options, parseBody, siteUrl } = require("./lib/http");
const { getStripe, stripeConfigured } = require("./lib/stripe-client");
const { BILLING_CADENCES, quote, isFlatType, maxQtyFor } = require("./lib/pricing");

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

  // NOTE: the browser also sends unitPrice / leadTypeLabel / ageBandLabel.
  // They are deliberately ignored: price and labels come only from the
  // server-side table in lib/pricing.js so a tampered request cannot change
  // what Stripe charges.
  const {
    leadType,
    ageBandId,
    quantity,
    states,
    billingCadence = "one-time",
    email,
    contactMethods,
    contactOther,
  } = body;

  const qty = Number(quantity);

  // Flat-priced products (Business Owner) have no age band, so ageBandId may
  // be omitted for them; lib/pricing.js still rejects a wrong band id.
  const needsBand = !isFlatType(leadType);
  if (!leadType || (needsBand && !ageBandId) || !email || !String(email).includes("@")) {
    return json(400, { ok: false, reason: "invalid_cart" });
  }
  // Per-product cap: 100,000 (MAX_QTY) for lead products, 1,000,000 for
  // Business Owner Raw Data (lib/pricing.js maxQtyFor).
  if (!Number.isInteger(qty) || qty < 1 || qty > maxQtyFor(leadType)) {
    return json(400, { ok: false, reason: "invalid_quantity" });
  }
  if (!Object.prototype.hasOwnProperty.call(BILLING_CADENCES, billingCadence)) {
    return json(400, { ok: false, reason: "invalid_cadence" });
  }
  if (!Array.isArray(states) || states.length === 0) {
    return json(400, { ok: false, reason: "invalid_states" });
  }

  // Server-side pricing: unknown leadType / ageBandId combos → 400.
  const priced = quote({ leadType, ageBandId, quantity: qty, billingCadence });
  if (!priced.ok) {
    const err = { ok: false, reason: priced.reason };
    // below_minimum tells the page the minimum (Business Owner: $100 / 33,334 records).
    if (priced.reason === "below_minimum") {
      err.minOrderCents = priced.minOrderCents;
      err.minQuantity = priced.minQuantity;
    }
    return json(400, err);
  }
  const amountCents = priced.amountCents;

  const stripe = getStripe();
  const origin = siteUrl(event);
  const productName = priced.flat
    ? `Lead Reload HQ — ${priced.leadTypeLabel} ($${priced.unitPrice} per ${priced.unit})`
    : `Lead Reload HQ — ${priced.leadTypeLabel} (${priced.ageBandLabel})`;
  const description = `${qty.toLocaleString("en-US")} ${priced.unit}s · ${states.join(",")}`;
  const buyerEmail = String(email).trim().slice(0, 200);

  const metadata = {
    leadType: priced.leadType,
    leadTypeLabel: priced.leadTypeLabel,
    ageBandId: priced.ageBandId,
    ageBandLabel: priced.ageBandLabel,
    quantity: String(priced.quantity),
    unitPrice: priced.unitPrice,
    unitPriceCents: String(priced.unitCents),
    amountCents: String(amountCents),
    pricing: "server",
    billingCadence: priced.billingCadence,
    states: states.join(",").slice(0, 450),
    contactMethods: Array.isArray(contactMethods)
      ? contactMethods.join(",").slice(0, 200)
      : "",
    contactOther: String(contactOther || "").slice(0, 120),
    source: "lead-reload-hq",
  };

  try {
    const sessionParams = {
      mode: priced.mode,
      customer_email: buyerEmail,
      success_url: `${origin}/?checkout=success&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${origin}/?checkout=cancel`,
      metadata,
      line_items: [],
    };

    if (priced.mode === "payment") {
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
      const interval = priced.interval;
      sessionParams.line_items = [
        {
          quantity: 1,
          price_data: {
            currency: "usd",
            unit_amount: amountCents,
            recurring: { interval },
            product_data: {
              name: productName,
              description: `${description} · ${priced.billingCadence}`,
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

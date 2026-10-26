"use strict";

const { getStripe, stripeConfigured } = require("./lib/stripe-client");
const { ordersStore, subsStore, setJson } = require("./lib/blobs");
const { text } = require("./lib/http");
const { deliverPaidOrderConfirmation } = require("./lib/order-confirmation");

/**
 * Exact bytes Stripe signed. Keep base64 bodies as a Buffer so signature
 * verification sees the original payload.
 */
function rawBody(event) {
  if (!event.body) return "";
  return event.isBase64Encoded
    ? Buffer.from(event.body, "base64")
    : event.body;
}

function header(event, name) {
  const headers = event.headers || {};
  const want = name.toLowerCase();
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === want) return headers[key];
  }
  return undefined;
}

function asObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value;
}

async function readExisting(store, key) {
  try {
    return asObject(await store.get(key, { type: "json" }));
  } catch (err) {
    console.error(
      "stripe-webhook: could not read existing record",
      err && err.message ? err.message : err
    );
    return {};
  }
}

/**
 * Refresh the checkout snapshot without undoing later fulfillment.
 * A Stripe retry must not flip a fulfilled order back to open, and must
 * keep confirmationEmail so the email stays idempotent.
 */
function checkoutRecord(existing, fresh) {
  const prior = asObject(existing);
  const priorEmail =
    prior.confirmationEmail && typeof prior.confirmationEmail === "object"
      ? prior.confirmationEmail
      : null;
  return {
    ...prior,
    ...fresh,
    status: prior.status || fresh.status,
    confirmationEmail: priorEmail,
  };
}

async function recordCheckoutSession(event, session) {
  const meta = session.metadata || {};
  const paidAt = new Date(
    (session.created || Math.floor(Date.now() / 1000)) * 1000
  ).toISOString();
  const email =
    session.customer_details?.email || session.customer_email || "";
  const contact = {
    email,
    methods: (meta.contactMethods || "").split(",").filter(Boolean),
    other: meta.contactOther || "",
  };

  if (session.mode === "payment") {
    const store = ordersStore(event);
    const existing = await readExisting(store, session.id);
    const record = checkoutRecord(existing, {
      id: session.id,
      type: "one-time",
      status: "open",
      email,
      amountTotal: session.amount_total,
      currency: session.currency,
      paidAt,
      stripeSessionId: session.id,
      stripePaymentIntentId: session.payment_intent || null,
      stripeCustomerId: session.customer || null,
      metadata: meta,
      qty: Number(meta.quantity) || null,
      billingCadence: meta.billingCadence || "one-time",
      contact,
      updatedAt: new Date().toISOString(),
    });
    await setJson(store, session.id, record);
    return { session, store, key: session.id, record };
  }

  if (session.mode === "subscription" && session.subscription) {
    const subId =
      typeof session.subscription === "string"
        ? session.subscription
        : session.subscription.id;
    const store = subsStore(event);
    const existing = await readExisting(store, subId);
    const record = checkoutRecord(existing, {
      id: subId,
      status: "active",
      email,
      stripeSessionId: session.id,
      stripeSubscriptionId: subId,
      stripeCustomerId: session.customer || null,
      billingCadence: meta.billingCadence || "monthly",
      qty: Number(meta.quantity) || null,
      metadata: meta,
      paidAt,
      contact,
      updatedAt: new Date().toISOString(),
    });
    await setJson(store, subId, record);
    return { session, store, key: subId, record };
  }

  return null;
}

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") return text(405, "method_not_allowed");

  // Never process unverified events. Without the signing secret we cannot
  // verify anything, so refuse outright (Stripe will retry once it is set).
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!secret) {
    console.error("stripe-webhook: STRIPE_WEBHOOK_SECRET not set — rejecting event");
    return text(503, "webhook_secret_not_configured");
  }
  if (!stripeConfigured()) return text(503, "stripe_not_configured");

  const sig = header(event, "stripe-signature");
  if (!sig) {
    return text(400, "missing_signature");
  }

  const stripe = getStripe();
  let stripeEvent;
  try {
    stripeEvent = stripe.webhooks.constructEvent(rawBody(event), sig, secret);
  } catch (err) {
    console.error("stripe-webhook: signature verification failed:", err.message);
    return text(400, "invalid_signature");
  }

  let savedCheckout = null;
  try {
    switch (stripeEvent.type) {
      case "checkout.session.completed":
      case "checkout.session.async_payment_succeeded": {
        savedCheckout = await recordCheckoutSession(event, stripeEvent.data.object);
        break;
      }
      case "customer.subscription.created":
      case "customer.subscription.updated":
      case "customer.subscription.deleted": {
        const sub = stripeEvent.data.object;
        const meta = sub.metadata || {};
        const store = subsStore(event);
        const existing = (await store.get(sub.id, { type: "json" })) || {};
        await setJson(store, sub.id, {
          ...existing,
          id: sub.id,
          status: sub.status,
          stripeSubscriptionId: sub.id,
          stripeCustomerId: sub.customer || existing.stripeCustomerId || null,
          billingCadence: meta.billingCadence || existing.billingCadence || null,
          qty: Number(meta.quantity) || existing.qty || null,
          metadata: Object.keys(meta).length ? meta : existing.metadata || {},
          cancelAtPeriodEnd: !!sub.cancel_at_period_end,
          currentPeriodEnd: sub.current_period_end
            ? new Date(sub.current_period_end * 1000).toISOString()
            : null,
          updatedAt: new Date().toISOString(),
        });
        break;
      }
      case "invoice.paid": {
        const invoice = stripeEvent.data.object;
        if (!invoice.subscription) break;
        const subId =
          typeof invoice.subscription === "string"
            ? invoice.subscription
            : invoice.subscription.id;
        const store = subsStore(event);
        const existing = (await store.get(subId, { type: "json" })) || {
          id: subId,
        };
        existing.lastInvoicePaidAt = new Date().toISOString();
        existing.lastInvoiceId = invoice.id;
        existing.status = existing.status || "active";
        existing.stripeCustomerId =
          existing.stripeCustomerId || invoice.customer || null;
        existing.updatedAt = new Date().toISOString();
        await setJson(store, subId, existing);
        break;
      }
      default:
        break;
    }
  } catch (err) {
    console.error("webhook handler error", err);
    return text(500, "handler_error");
  }

  // Email runs only after the order is stored, and only for a paid checkout.
  // Failures are swallowed: Stripe must still see 200 so it does not retry
  // the whole event solely because mail failed. Renewals (invoice.paid) and
  // expired/abandoned sessions never reach this call.
  if (savedCheckout && savedCheckout.session && savedCheckout.session.payment_status === "paid") {
    try {
      await deliverPaidOrderConfirmation(savedCheckout);
    } catch (err) {
      console.error(
        "order confirmation email failed (order was saved)",
        err && err.message ? err.message : err
      );
    }
  }

  return text(200, "ok");
};

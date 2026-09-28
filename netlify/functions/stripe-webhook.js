"use strict";

const { getStripe, stripeConfigured } = require("./lib/stripe-client");
const { ordersStore, subsStore, setJson } = require("./lib/blobs");
const { text } = require("./lib/http");
const { upsertOrder } = require("./lib/orders");

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

const idOf = (v) => (v && typeof v === "object" ? v.id : v) || null;
const isoFromUnix = (t) => (t ? new Date(t * 1000).toISOString() : null);
const splitList = (v) => String(v || "").split(",").filter(Boolean);

/**
 * invoice.paid reasons that do NOT get their own order row.
 * subscription_create is the first invoice of a new subscription; that period
 * is already the "subscription" order written from checkout.session.completed
 * (keyed by the session id), so skipping it avoids counting it twice.
 * Every other paid subscription invoice (subscription_cycle renewals, and
 * rarer manual / subscription_update / threshold invoices) becomes a
 * "renewal" row keyed by the invoice id.
 */
const NO_ORDER_BILLING_REASONS = Object.freeze(["subscription_create"]);

// Stripe API <= 2025-02 puts these on the invoice; 2025-03 "basil" and later
// move them under invoice.parent.subscription_details. Accept both.
function invoiceSubscriptionId(invoice) {
  return (
    idOf(invoice.subscription) ||
    idOf(invoice.parent?.subscription_details?.subscription) ||
    null
  );
}

function invoiceSubscriptionMetadata(invoice) {
  return (
    invoice.subscription_details?.metadata ||
    invoice.parent?.subscription_details?.metadata ||
    {}
  );
}

function invoicePeriod(invoice) {
  const lines = (invoice.lines && invoice.lines.data) || [];
  const line = lines.find((l) => l && l.period && l.period.start) || null;
  const period = line ? line.period : { start: invoice.period_start, end: invoice.period_end };
  return { periodStart: isoFromUnix(period.start), periodEnd: isoFromUnix(period.end) };
}

/** First paid period of a subscription checkout, as a fulfillable order. */
function subscriptionOrder(session, subId, meta, email, paidAt) {
  return {
    id: session.id,
    kind: "subscription",
    type: "subscription",
    email,
    amountTotal: session.amount_total,
    currency: session.currency,
    paidAt,
    stripeSessionId: session.id,
    stripePaymentIntentId: idOf(session.payment_intent),
    stripeInvoiceId: idOf(session.invoice),
    stripeSubscriptionId: subId,
    stripeCustomerId: idOf(session.customer),
    metadata: meta,
    qty: Number(meta.quantity) || null,
    billingCadence: meta.billingCadence || "monthly",
    contact: {
      email,
      methods: splitList(meta.contactMethods),
      other: meta.contactOther || "",
    },
    updatedAt: new Date().toISOString(),
  };
}

/**
 * A paid renewal invoice as its own fulfillable order. Lead type, age band,
 * quantity and states come from the subscription metadata (the invoice's
 * snapshot first, then the stored subscription record).
 */
function renewalOrder(invoice, subId, subRecord) {
  const meta = { ...(subRecord.metadata || {}), ...invoiceSubscriptionMetadata(invoice) };
  const email = invoice.customer_email || subRecord.email || "";
  const paidTs = invoice.status_transitions?.paid_at || invoice.created;
  return {
    id: invoice.id,
    kind: "renewal",
    type: "renewal",
    email,
    amountTotal: invoice.amount_paid != null ? invoice.amount_paid : invoice.total ?? null,
    currency: invoice.currency,
    paidAt: isoFromUnix(paidTs) || new Date().toISOString(),
    stripeSessionId: null,
    stripePaymentIntentId: idOf(invoice.payment_intent),
    stripeInvoiceId: invoice.id,
    stripeSubscriptionId: subId,
    stripeCustomerId: idOf(invoice.customer) || subRecord.stripeCustomerId || null,
    billingReason: invoice.billing_reason || null,
    ...invoicePeriod(invoice),
    metadata: meta,
    qty: Number(meta.quantity) || subRecord.qty || null,
    billingCadence: meta.billingCadence || subRecord.billingCadence || null,
    contact: subRecord.contact || {
      email,
      methods: splitList(meta.contactMethods),
      other: meta.contactOther || "",
    },
    updatedAt: new Date().toISOString(),
  };
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

  // Order rows are keyed by Stripe session id / invoice id, and upsertOrder
  // keeps the admin's fulfillment status, so retries never duplicate or reset.
  const saveOrder = (key, row) => upsertOrder(ordersStore(event), key, row, setJson);

  try {
    switch (stripeEvent.type) {
      case "checkout.session.completed": {
        const session = stripeEvent.data.object;
        const meta = session.metadata || {};
        const paidAt = new Date(
          (session.created || Math.floor(Date.now() / 1000)) * 1000
        ).toISOString();
        const email =
          session.customer_details?.email || session.customer_email || "";

        if (session.mode === "payment") {
          await saveOrder(session.id, {
            id: session.id,
            type: "one-time",
            kind: "one-time",
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
            contact: {
              email,
              methods: (meta.contactMethods || "").split(",").filter(Boolean),
              other: meta.contactOther || "",
            },
            updatedAt: new Date().toISOString(),
          });
        } else if (session.mode === "subscription" && session.subscription) {
          const subId =
            typeof session.subscription === "string"
              ? session.subscription
              : session.subscription.id;
          await setJson(subsStore(event), subId, {
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
            contact: {
              email,
              methods: (meta.contactMethods || "").split(",").filter(Boolean),
              other: meta.contactOther || "",
            },
            updatedAt: new Date().toISOString(),
          });
          // The first paid period is also a fulfillable order (keyed by the
          // session id). Its invoice (billing_reason subscription_create) is
          // skipped in invoice.paid so it is not counted twice.
          await saveOrder(
            session.id,
            subscriptionOrder(session, subId, meta, email, paidAt)
          );
        }
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
        const subId = invoiceSubscriptionId(invoice);
        if (!subId) break;
        const store = subsStore(event);
        const existing = (await store.get(subId, { type: "json" })) || {
          id: subId,
        };
        if (!NO_ORDER_BILLING_REASONS.includes(invoice.billing_reason)) {
          await saveOrder(invoice.id, renewalOrder(invoice, subId, existing));
        }
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

  return text(200, "ok");
};

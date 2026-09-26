"use strict";

/**
 * Server-side price table for Lead Reload HQ.
 *
 * This is the ONLY source of truth for what Stripe charges. create-checkout
 * computes every amount from this table and ignores any price the browser
 * sends.
 *
 * Prices set by Dan 2026-09-25: both lead-type tables use the same 5 age
 * bands (under 30, 30–60, 60–90, 90–365, 365+ days). The storefront still
 * renders its own copy for display (PRICING in public/app.js), so if you
 * change a price here you MUST change public/app.js to match (and vice
 * versa). `npm run test:pricing` fails if the two ever disagree.
 *
 * Pricing model (mirrors the frontend exactly):
 *   total = unit price for (lead type, age band) × quantity
 *   - no quantity tiers / volume discounts
 *   - no per-state or contact-method surcharges
 *   - weekly / monthly cost the same per bill as one-time
 * Prices are stored in integer cents to avoid floating-point drift.
 */

const MIN_QTY = 1;
const MAX_QTY = 100000;
/** Stripe's minimum charge for USD. */
const MIN_AMOUNT_CENTS = 50;

const LEAD_TYPES = Object.freeze({
  "general-life": Object.freeze({ id: "general-life", label: "General Life", pricingKey: "lifeMp" }),
  "mortgage-protection": Object.freeze({ id: "mortgage-protection", label: "Mortgage Protection", pricingKey: "lifeMp" }),
  "private-health": Object.freeze({ id: "private-health", label: "Private Health", pricingKey: "privateHealth" }),
});

/**
 * Private Health, 90–365 days, in dollars per lead.
 * Confirmed by Dan 2026-09-25 ($0.13); keep both values in sync.
 * If the price ever changes, edit this line AND the matching
 * `PRIVATE_HEALTH_90_365` line in public/app.js (same value), then `npm test`.
 * Must be a whole number of cents (e.g. 0.13, 0.15).
 */
const PRIVATE_HEALTH_90_365 = 0.13;

/** Dollars → integer cents; refuses fractional-cent prices. */
function toCents(dollars) {
  const cents = Math.round(dollars * 100);
  if (!Number.isFinite(dollars) || dollars <= 0 || Math.abs(dollars * 100 - cents) > 1e-9) {
    throw new Error(`pricing.js: invalid price ${dollars} (must be a positive whole number of cents)`);
  }
  return cents;
}

function band(id, label, unitCents) {
  return Object.freeze({ id, label, unitCents });
}

/**
 * Customer-facing unit prices in cents, per age band. Same 5 bands for both
 * tables. Retired band ids (ph-90-180, ph-180-360, lm-90) are intentionally
 * absent, so create-checkout answers them with 400 invalid_age_band.
 */
const PRICE_TABLES = Object.freeze({
  privateHealth: Object.freeze([
    band("ph-u30", "Under 30 days", 52),
    band("ph-30-60", "30–60 days", 33),
    band("ph-60-90", "60–90 days", 26),
    band("ph-90-365", "90–365 days", toCents(PRIVATE_HEALTH_90_365)),
    band("ph-365", "365+ days", 3),
  ]),
  lifeMp: Object.freeze([
    band("lm-u30", "Under 30 days", 52),
    band("lm-30-60", "30–60 days", 39),
    band("lm-60-90", "60–90 days", 20),
    band("lm-90-365", "90–365 days", 10),
    band("lm-365", "365+ days", 3),
  ]),
});

const BILLING_CADENCES = Object.freeze({
  "one-time": Object.freeze({ id: "one-time", label: "One-time", mode: "payment", interval: null }),
  weekly: Object.freeze({ id: "weekly", label: "Weekly", mode: "subscription", interval: "week" }),
  monthly: Object.freeze({ id: "monthly", label: "Monthly", mode: "subscription", interval: "month" }),
});

function own(obj, key) {
  return typeof key === "string" && Object.prototype.hasOwnProperty.call(obj, key);
}

function getLeadType(leadType) {
  return own(LEAD_TYPES, leadType) ? LEAD_TYPES[leadType] : null;
}

function getBand(leadType, ageBandId) {
  const type = getLeadType(leadType);
  if (!type || typeof ageBandId !== "string") return null;
  return PRICE_TABLES[type.pricingKey].find((b) => b.id === ageBandId) || null;
}

function getCadence(billingCadence) {
  return own(BILLING_CADENCES, billingCadence) ? BILLING_CADENCES[billingCadence] : null;
}

function centsToDollarString(cents) {
  return (cents / 100).toFixed(2);
}

/**
 * Price a cart entirely server-side.
 * Returns { ok:true, ... } or { ok:false, reason } (reason is safe to return
 * to the browser with a 400).
 */
function quote({ leadType, ageBandId, quantity, billingCadence = "one-time" } = {}) {
  const type = getLeadType(leadType);
  if (!type) return { ok: false, reason: "invalid_lead_type" };

  const ageBand = getBand(leadType, ageBandId);
  if (!ageBand) return { ok: false, reason: "invalid_age_band" };

  const qty = Number(quantity);
  if (!Number.isInteger(qty) || qty < MIN_QTY || qty > MAX_QTY) {
    return { ok: false, reason: "invalid_quantity" };
  }

  const cadence = getCadence(billingCadence);
  if (!cadence) return { ok: false, reason: "invalid_cadence" };

  const amountCents = ageBand.unitCents * qty;
  if (amountCents < MIN_AMOUNT_CENTS) {
    return { ok: false, reason: "amount_too_small" };
  }

  return {
    ok: true,
    leadType: type.id,
    leadTypeLabel: type.label,
    ageBandId: ageBand.id,
    ageBandLabel: ageBand.label,
    quantity: qty,
    unitCents: ageBand.unitCents,
    unitPrice: centsToDollarString(ageBand.unitCents),
    amountCents,
    amount: centsToDollarString(amountCents),
    billingCadence: cadence.id,
    mode: cadence.mode,
    interval: cadence.interval,
  };
}

module.exports = {
  MIN_QTY,
  MAX_QTY,
  MIN_AMOUNT_CENTS,
  PRIVATE_HEALTH_90_365,
  LEAD_TYPES,
  PRICE_TABLES,
  BILLING_CADENCES,
  getLeadType,
  getBand,
  getCadence,
  centsToDollarString,
  quote,
};

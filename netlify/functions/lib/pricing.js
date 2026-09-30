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
 *
 * Business Owner Raw Data (added 2026-09-28, repriced by Dan the same
 * evening): $0.003 per record ($30 per 10,000), one flat price with no age
 * band. Its unit price is less than a cent, so every band also carries
 * `unitMills` (tenths of a cent, integer) and the total is computed in
 * integer math as
 *   amountCents = ceil(unitMills × quantity / 10)
 * i.e. rounded UP to the next whole cent when quantity is not a multiple of
 * 10 (at most 0.9¢ over the exact amount, never under). Business Owner
 * presets (35,000 / 50,000 / 100,000 / 250,000) are multiples of 10, so they
 * are exact. For the whole-cent bands unitMills = unitCents × 10, so their
 * totals are unchanged (unitCents × quantity).
 *
 * Business Owner limits (per lead type, other products unchanged):
 *   - $100 minimum order on the RAW total (records × $0.003 ≥ $100, checked
 *     before rounding), so 33,334 records is the smallest order (33,333 is
 *     $99.999). Below it → 400 `below_minimum`. Applies to every cadence.
 *   - max 1,000,000 records per order (others keep MAX_QTY = 100,000).
 */

const MIN_QTY = 1;
const MAX_QTY = 100000;
/** Stripe's minimum charge for USD. */
const MIN_AMOUNT_CENTS = 50;

const LEAD_TYPES = Object.freeze({
  "general-life": Object.freeze({ id: "general-life", label: "General Life", pricingKey: "lifeMp" }),
  "mortgage-protection": Object.freeze({ id: "mortgage-protection", label: "Mortgage Protection", pricingKey: "lifeMp" }),
  "private-health": Object.freeze({ id: "private-health", label: "Private Health", pricingKey: "privateHealth" }),
  "business-owner": Object.freeze({
    id: "business-owner",
    label: "Business Owner Raw Data",
    pricingKey: "businessOwner",
    unit: "record",
    // $100 minimum on the raw (unrounded) total; see header comment.
    minOrderCents: 10000,
    maxQty: 1000000,
  }),
});

/**
 * Business Owner Raw Data, dollars per record. Flat price, no age band.
 * Keep in sync with BUSINESS_OWNER_PER_RECORD in public/app.js (`npm test`
 * fails if they differ). Must be a whole number of tenths of a cent.
 */
const BUSINESS_OWNER_PER_RECORD = 0.003;
/** The single pseudo band for flat-priced products (no age band applies). */
const FLAT_BAND_ID = "bo-flat";
const FLAT_BAND_LABEL = "No age band (flat rate)";

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

/** Dollars → integer tenths of a cent (mills); refuses finer prices. */
function toMills(dollars) {
  const mills = Math.round(dollars * 1000);
  if (!Number.isFinite(dollars) || dollars <= 0 || Math.abs(dollars * 1000 - mills) > 1e-9) {
    throw new Error(`pricing.js: invalid price ${dollars} (must be a positive whole number of tenths of a cent)`);
  }
  return mills;
}

function band(id, label, unitCents) {
  return Object.freeze({ id, label, unitCents, unitMills: unitCents * 10, flat: false });
}

/** Flat product: one price regardless of lead age. unitCents may be fractional. */
function flatBand(dollars) {
  const unitMills = toMills(dollars);
  return Object.freeze({
    id: FLAT_BAND_ID,
    label: FLAT_BAND_LABEL,
    unitCents: unitMills / 10,
    unitMills,
    flat: true,
  });
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
  businessOwner: Object.freeze([flatBand(BUSINESS_OWNER_PER_RECORD)]),
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

/** True when the lead type has one flat price and no age band choice. */
function isFlatType(leadType) {
  const type = getLeadType(leadType);
  if (!type) return false;
  const table = PRICE_TABLES[type.pricingKey];
  return table.length === 1 && table[0].flat === true;
}

/** Integer cents for quantity × band price, rounded up to a whole cent. */
function amountCentsFor(b, quantity) {
  return Math.floor((b.unitMills * quantity + 9) / 10);
}

/** Largest quantity allowed for a lead type (Business Owner: 1,000,000). */
function maxQtyFor(leadType) {
  const type = getLeadType(leadType);
  return (type && type.maxQty) || MAX_QTY;
}

/** Product minimum in cents on the raw total (Business Owner: 10000), else 0. */
function minOrderCentsFor(leadType) {
  const type = getLeadType(leadType);
  return (type && type.minOrderCents) || 0;
}

/**
 * True when quantity × unit price, BEFORE rounding, meets the product
 * minimum. Integer math: unitMills × qty ≥ minOrderCents × 10.
 */
function meetsProductMinimum(leadType, b, quantity) {
  return b.unitMills * quantity >= minOrderCentsFor(leadType) * 10;
}

/** Smallest quantity that meets the product minimum (Business Owner: 33,334). */
function minQtyFor(leadType) {
  const type = getLeadType(leadType);
  if (!type) return MIN_QTY;
  const b = PRICE_TABLES[type.pricingKey][0];
  const min = minOrderCentsFor(leadType);
  return min ? Math.max(MIN_QTY, Math.ceil((min * 10) / b.unitMills)) : MIN_QTY;
}

/** "0.52", "0.03", or "0.003" for sub-cent prices. */
function unitPriceString(b) {
  return b.unitMills % 10 === 0
    ? centsToDollarString(b.unitMills / 10)
    : (b.unitMills / 1000).toFixed(3);
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

  // Flat products (Business Owner) have no age band: the storefront sends
  // "bo-flat"; a missing / "n/a" band is accepted too. Any other band id
  // (e.g. a Life band on Business Owner) is still a 400.
  const flatNoBand =
    isFlatType(leadType) &&
    (ageBandId === undefined || ageBandId === null || ageBandId === "" || ageBandId === "n/a");
  const ageBand = flatNoBand
    ? PRICE_TABLES[type.pricingKey][0]
    : getBand(leadType, ageBandId);
  if (!ageBand) return { ok: false, reason: "invalid_age_band" };

  const qty = Number(quantity);
  if (!Number.isInteger(qty) || qty < MIN_QTY || qty > maxQtyFor(leadType)) {
    return { ok: false, reason: "invalid_quantity" };
  }

  const cadence = getCadence(billingCadence);
  if (!cadence) return { ok: false, reason: "invalid_cadence" };

  // Product minimum (Business Owner $100), on the raw total before rounding.
  if (!meetsProductMinimum(leadType, ageBand, qty)) {
    return { ok: false, reason: "below_minimum", minOrderCents: minOrderCentsFor(leadType), minQuantity: minQtyFor(leadType) };
  }

  const amountCents = amountCentsFor(ageBand, qty);
  if (amountCents < MIN_AMOUNT_CENTS) {
    return { ok: false, reason: "amount_too_small" };
  }

  return {
    ok: true,
    leadType: type.id,
    leadTypeLabel: type.label,
    ageBandId: ageBand.id,
    ageBandLabel: ageBand.label,
    flat: ageBand.flat,
    unit: type.unit || "lead",
    quantity: qty,
    unitCents: ageBand.unitCents,
    unitMills: ageBand.unitMills,
    unitPrice: unitPriceString(ageBand),
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
  BUSINESS_OWNER_PER_RECORD,
  FLAT_BAND_ID,
  FLAT_BAND_LABEL,
  LEAD_TYPES,
  PRICE_TABLES,
  BILLING_CADENCES,
  getLeadType,
  getBand,
  getCadence,
  isFlatType,
  maxQtyFor,
  minOrderCentsFor,
  minQtyFor,
  meetsProductMinimum,
  amountCentsFor,
  unitPriceString,
  centsToDollarString,
  quote,
};

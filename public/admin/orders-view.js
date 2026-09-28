/*
 * Order display + CSV helpers for /admin/ (browser: window.LRAdminOrders).
 * Also loaded by scripts/test-fulfillment.js under Node, so keep it free of
 * DOM access.
 */
(function (root, factory) {
  "use strict";
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.LRAdminOrders = api;
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  const cap = (s) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : "");

  function meta(o) {
    return (o && o.metadata) || {};
  }

  function kindOf(o) {
    const k = o && (o.kind || o.type);
    return k === "subscription" || k === "renewal" ? k : "one-time";
  }

  /** "One-time", "Weekly subscription", "Monthly renewal". */
  function cadenceLabel(o) {
    const kind = kindOf(o);
    if (kind === "one-time") return "One-time";
    const cadence = String((o && o.billingCadence) || meta(o).billingCadence || "").toLowerCase();
    const c = cadence === "weekly" || cadence === "monthly" ? cadence : "";
    if (kind === "renewal") return c ? cap(c) + " renewal" : "Renewal";
    return c ? cap(c) + " subscription" : "Subscription";
  }

  function leadTypeLabel(o) {
    const m = meta(o);
    return m.leadTypeLabel || m.leadType || "";
  }

  function ageBandLabel(o) {
    const m = meta(o);
    return m.ageBandLabel || m.ageBandId || "";
  }

  function quantity(o) {
    const q = (o && o.qty) || meta(o).quantity;
    return q == null || q === "" ? "" : String(q);
  }

  function states(o) {
    return String(meta(o).states || "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
      .join(", ");
  }

  function amountDecimal(o) {
    if (!o || o.amountTotal == null || o.amountTotal === "") return "";
    const n = Number(o.amountTotal);
    return Number.isFinite(n) ? (n / 100).toFixed(2) : "";
  }

  function paymentRef(o) {
    return (o && (o.stripePaymentIntentId || o.stripeInvoiceId)) || "";
  }

  function fulfillmentStatus(o) {
    const s = o && o.fulfillmentStatus;
    if (s === "New" || s === "In progress" || s === "Completed") return s;
    return o && o.status === "fulfilled" ? "Completed" : "New";
  }

  // Columns of the CSV export, in order.
  const CSV_COLUMNS = [
    ["Paid at (UTC)", (o) => o.paidAt || ""],
    ["Customer email", (o) => o.email || (o.contact && o.contact.email) || ""],
    ["Lead type", leadTypeLabel],
    ["Age band", ageBandLabel],
    ["Quantity", quantity],
    ["States", states],
    ["Amount", amountDecimal],
    ["Currency", (o) => String(o.currency || "").toUpperCase()],
    ["Cadence / type", cadenceLabel],
    ["Stripe session id", (o) => o.stripeSessionId || ""],
    ["Payment intent id", (o) => o.stripePaymentIntentId || ""],
    ["Invoice id", (o) => o.stripeInvoiceId || ""],
    ["Subscription id", (o) => o.stripeSubscriptionId || ""],
    ["Period start", (o) => o.periodStart || ""],
    ["Period end", (o) => o.periodEnd || ""],
    ["Fulfillment status", fulfillmentStatus],
    ["Completed at", (o) => o.completedAt || ""],
    ["Completed by", (o) => o.completedBy || ""],
    ["Status updated at", (o) => o.statusUpdatedAt || ""],
    ["Status updated by", (o) => o.statusUpdatedBy || ""],
    ["Order id", (o) => o.id || ""],
  ];

  /**
   * One CSV cell. Cells starting with = + - @ (or tab / CR) are prefixed
   * with ' so spreadsheets never evaluate them as formulas; then the value
   * is quoted if it contains a comma, quote, CR/LF or edge whitespace, with
   * inner quotes doubled.
   */
  function csvCell(value) {
    let s = value == null ? "" : String(value);
    if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
    if (/[",\r\n]/.test(s) || /^\s|\s$/.test(s)) {
      s = '"' + s.replace(/"/g, '""') + '"';
    }
    return s;
  }

  function toCsv(orders) {
    const lines = [CSV_COLUMNS.map(([h]) => csvCell(h)).join(",")];
    for (const o of orders || []) {
      lines.push(CSV_COLUMNS.map(([, get]) => csvCell(get(o || {}))).join(","));
    }
    return lines.join("\r\n") + "\r\n";
  }

  return {
    CSV_COLUMNS,
    cadenceLabel,
    leadTypeLabel,
    ageBandLabel,
    quantity,
    states,
    amountDecimal,
    paymentRef,
    fulfillmentStatus,
    kindOf,
    csvCell,
    toCsv,
  };
});

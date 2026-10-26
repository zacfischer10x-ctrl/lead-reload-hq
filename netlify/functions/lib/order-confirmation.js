"use strict";

/**
 * Paid-order confirmation copy, and the webhook hook that sends it.
 *
 * Sent only for a checkout session whose payment_status is "paid"
 * (checkout.session.completed, or checkout.session.async_payment_succeeded
 * for a delayed payment method). One send per checkout session: a later
 * delivery of the same event sees confirmationEmail.status === "sent" and
 * does nothing. A send error is stored on the order and never thrown, so
 * Stripe still gets 200 and fulfillment is left alone.
 *
 * invoice.paid (weekly or monthly renewals) does not send this email.
 */

const { setJson } = require("./blobs");
const { sendEmail, resolveEmailSettings } = require("./email");

const SUBJECT = "Your Lead Reload HQ order is confirmed";

/**
 * Main and PROJECT_BRIEF.md do not state a turnaround time. The sentences
 * outside this placeholder are the storefront's own wording. The live Terms
 * of Sale (production only, version 2026-10-01-tos2) do state 3-5 business
 * days; that wording stays inside the placeholder until Zac replaces it.
 */
const DELIVERY_TIMELINE_PLACEHOLDER =
  "[PLACEHOLDER: Zac, replace this paragraph before customers rely on it. This repo and PROJECT_BRIEF.md do not define a turnaround time. The storefront says fulfillment follows the state and age-band selection, and that large or multi-state orders get a confirmed delivery window. The live Terms of Sale (version 2026-10-01-tos2, on the production site but not on main) say to allow up to 3-5 business days from payment, that large or multi-state orders can take longer, and that delivery is a data file or download link sent to the checkout email. Those terms also say each subscription period is delivered within 3-5 business days of that period's payment.]";

const CONTACT_PLACEHOLDER =
  "[PLACEHOLDER: set ORDER_EMAIL_REPLY_TO to the Workspace mailbox customers should use. Dan's plan is support@leadreloadhq.com. The live Terms of Sale currently list dwhigham94@gmail.com.]";

const SENDING_LOCK_MS = 60 * 1000;

function esc(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function formatMoney(cents, currency) {
  const n = Number(cents);
  if (!Number.isFinite(n)) return "Not specified";
  const code = String(currency || "usd").toUpperCase();
  const amount = (n / 100).toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  return code === "USD" ? `$${amount} USD` : `${amount} ${code}`;
}

function formatOrderDate(unixSeconds) {
  const sec = Number(unixSeconds);
  if (!Number.isFinite(sec)) return "Not specified";
  const date = new Date(sec * 1000);
  if (Number.isNaN(date.getTime())) return "Not specified";
  const formatted = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "long",
    day: "numeric",
  }).format(date);
  return `${formatted} (ET)`;
}

function formatCount(value) {
  if (value == null || String(value).trim() === "") return "Not specified";
  const n = Number(value);
  if (!Number.isFinite(n)) return "Not specified";
  return Math.round(n).toLocaleString("en-US");
}

function formatStates(value) {
  const states = String(value || "")
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
  return states.length ? states.join(", ") : "Not specified";
}

function billingLines(cadence) {
  switch (cadence) {
    case "weekly":
      return {
        label: "Weekly subscription",
        detail:
          "This amount is charged now and then every week until you cancel. To cancel or change this subscription, reply to this email.",
      };
    case "monthly":
      return {
        label: "Monthly subscription",
        detail:
          "This amount is charged now and then every month until you cancel. To cancel or change this subscription, reply to this email.",
      };
    case "one-time":
      return {
        label: "One-time purchase",
        detail: "This is a single charge and does not renew.",
      };
    default:
      return {
        label: cadence ? String(cadence) : "Not specified",
        detail: "",
      };
  }
}

function contactLine(supportEmail) {
  const email = String(supportEmail || "").trim();
  if (email.includes("@") && !/[\r\n]/.test(email)) {
    return `Questions: reply to this email, or write to ${email}.`;
  }
  return `Questions: ${CONTACT_PLACEHOLDER}`;
}

function orderViewFromSession(session, supportEmail) {
  const meta = (session && session.metadata) || {};
  const cadence =
    meta.billingCadence ||
    (session && session.mode === "payment" ? "one-time" : "");
  const product = String(meta.leadTypeLabel || meta.leadType || "").trim();
  const age = String(meta.ageBandLabel || "").trim();
  return {
    product: product || "Not specified",
    leadCount: formatCount(meta.quantity),
    ageRange: age || "Not applicable",
    states: formatStates(meta.states),
    billingCadence: cadence,
    amount: formatMoney(session && session.amount_total, session && session.currency),
    orderDate: formatOrderDate(session && session.created),
    reference: (session && session.id) || "Not specified",
    supportEmail: supportEmail || "",
  };
}

function buildOrderConfirmation(view) {
  const billing = billingLines(view.billingCadence);
  const rows = [
    ["Product", view.product || "Not specified"],
    ["Lead count", view.leadCount || "Not specified"],
    ["Age range", view.ageRange || "Not applicable"],
    ["States", view.states || "Not specified"],
    ["Billing", billing.label],
    ["Amount paid", view.amount || "Not specified"],
    ["Order date", view.orderDate || "Not specified"],
    ["Order reference", view.reference || "Not specified"],
  ];
  const next = [
    "Fulfillment follows the state and age-band selection on this order. For a large or multi-state order, we will confirm the delivery window.",
  ];
  if (billing.detail) next.push(billing.detail);
  const contact = contactLine(view.supportEmail);
  const text = [
    "Lead Reload HQ",
    "https://leadreloadhq.com",
    "",
    "Thank you for your order.",
    "",
    "Your payment went through, and this email confirms the order below.",
    "",
    "ORDER SUMMARY",
    ...rows.map(([label, value]) => `${label}: ${value}`),
    "",
    "WHAT HAPPENS NEXT",
    ...next,
    "",
    "EXPECTED DELIVERY TIMELINE",
    DELIVERY_TIMELINE_PLACEHOLDER,
    "",
    contact,
    "",
    "Lead Reload HQ",
    "Aged insurance lead marketplace",
    "https://leadreloadhq.com",
    "",
  ].join("\n");

  const rowHtml = rows
    .map(
      ([label, value]) =>
        `<tr><td style="padding:6px 12px 6px 0;color:#5c6b82;vertical-align:top;width:148px;">${esc(
          label
        )}</td><td style="padding:6px 0;color:#1c2430;font-weight:600;">${esc(value)}</td></tr>`
    )
    .join("");
  const nextHtml = next
    .map((paragraph) => `<p style="margin:0 0 12px;">${esc(paragraph)}</p>`)
    .join("");
  const html = `<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8"><title>${esc(SUBJECT)}</title></head>
<body style="margin:0;padding:0;background:#f4f1ea;">
  <div style="display:none;max-height:0;overflow:hidden;">${esc(SUBJECT)}</div>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f1ea;">
    <tr><td align="center" style="padding:24px 12px;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border:1px solid #e6dfd0;">
        <tr><td style="background:#0a1224;padding:20px 24px;border-bottom:3px solid #d4a84b;">
          <p style="margin:0;font-family:Georgia,'Times New Roman',serif;font-size:22px;line-height:1.2;color:#f2f4f8;">Lead Reload HQ</p>
          <p style="margin:6px 0 0;font-family:Georgia,'Times New Roman',serif;font-size:13px;letter-spacing:0.04em;color:#e8c36a;">Aged insurance lead marketplace</p>
        </td></tr>
        <tr><td style="padding:24px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;font-size:15px;line-height:1.5;color:#1c2430;">
          <p style="margin:0 0 12px;">Thank you for your order.</p>
          <p style="margin:0 0 20px;">Your payment went through, and this email confirms the order below.</p>
          <p style="margin:0 0 8px;font-size:12px;letter-spacing:0.06em;text-transform:uppercase;color:#5c6b82;">Order summary</p>
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 20px;">${rowHtml}</table>
          <p style="margin:0 0 8px;font-size:12px;letter-spacing:0.06em;text-transform:uppercase;color:#5c6b82;">What happens next</p>
          ${nextHtml}
          <p style="margin:0 0 8px;font-size:12px;letter-spacing:0.06em;text-transform:uppercase;color:#5c6b82;">Expected delivery timeline</p>
          <p style="margin:0 0 20px;">${esc(DELIVERY_TIMELINE_PLACEHOLDER)}</p>
          <p style="margin:0 0 20px;">${esc(contact)}</p>
          <p style="margin:0;color:#5c6b82;">Lead Reload HQ<br>Aged insurance lead marketplace<br><a href="https://leadreloadhq.com" style="color:#1e3358;">https://leadreloadhq.com</a></p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;

  return { subject: SUBJECT, text, html };
}

async function writeEmailStatus(store, key, record, confirmationEmail) {
  record.confirmationEmail = confirmationEmail;
  try {
    await setJson(store, key, record);
  } catch (err) {
    console.error(
      "order confirmation: could not store email status",
      err && err.message ? err.message : err
    );
  }
}

/**
 * Send the confirmation for a stored paid checkout. Never throws.
 * `saved` is { session, store, key, record } from the webhook.
 */
async function deliverPaidOrderConfirmation(saved) {
  if (!saved || !saved.session || !saved.store || !saved.key || !saved.record) return;
  const { session, store, key, record } = saved;
  if (session.payment_status !== "paid") return;

  const sessionId = session.id || key;
  const prior = record.confirmationEmail;
  if (prior && prior.status === "sent" && prior.sessionId === sessionId) return;
  if (prior && prior.status === "sending" && prior.sessionId === sessionId) {
    const started = Date.parse(prior.at || "");
    if (Number.isFinite(started) && Date.now() - started < SENDING_LOCK_MS) return;
  }

  const to = String(record.email || "").trim();
  if (!to.includes("@") || /[\r\n]/.test(to)) {
    await writeEmailStatus(store, key, record, {
      status: "skipped",
      reason: "no_recipient",
      sessionId,
      at: new Date().toISOString(),
    });
    console.error(`order confirmation email skipped for ${sessionId}: no_recipient`);
    return;
  }

  try {
    const settings = resolveEmailSettings();
    const built = buildOrderConfirmation(orderViewFromSession(session, settings.replyTo));
    await writeEmailStatus(store, key, record, {
      status: "sending",
      sessionId,
      at: new Date().toISOString(),
    });
    const result = await sendEmail({
      to,
      subject: built.subject,
      text: built.text,
      html: built.html,
      idempotencyKey: `order-confirmation:${sessionId}`,
    });
    if (result && result.ok) {
      await writeEmailStatus(store, key, record, {
        status: "sent",
        sessionId,
        sentAt: new Date().toISOString(),
        messageId: result.id || null,
      });
      console.log(`order confirmation email sent for ${sessionId}`);
      return;
    }
    const skipped = !!(result && result.skipped);
    const reason = (result && result.reason) || "email_send_failed";
    await writeEmailStatus(store, key, record, {
      status: skipped ? "skipped" : "failed",
      reason,
      sessionId,
      at: new Date().toISOString(),
    });
    console.error(
      `order confirmation email ${skipped ? "skipped" : "failed"} for ${sessionId}: ${reason}`
    );
  } catch (err) {
    console.error(
      `order confirmation email failed for ${sessionId} (order was saved):`,
      err && err.message ? err.message : err
    );
    await writeEmailStatus(store, key, record, {
      status: "failed",
      reason: "email_send_failed",
      sessionId,
      at: new Date().toISOString(),
    });
  }
}

module.exports = {
  SUBJECT,
  DELIVERY_TIMELINE_PLACEHOLDER,
  CONTACT_PLACEHOLDER,
  buildOrderConfirmation,
  orderViewFromSession,
  deliverPaidOrderConfirmation,
  formatMoney,
  formatOrderDate,
};

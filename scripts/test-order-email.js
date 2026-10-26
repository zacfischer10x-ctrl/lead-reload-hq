#!/usr/bin/env node
/* eslint-disable no-console */
"use strict";

/**
 * Order confirmation email: copy, Gmail API request shape, and webhook
 * rules (paid only, one email per checkout, mail failure still returns 200).
 * No network. The Gmail HTTPS calls are stubbed.
 *
 *   node scripts/test-order-email.js
 */

const path = require("path");
const fs = require("fs");
const assert = require("assert");
const crypto = require("crypto");

const ROOT = path.resolve(__dirname, "..");
const PLACEHOLDER_KEY = "unit-test-placeholder-not-a-stripe-key";
const PLACEHOLDER_SECRET = "unit-test-placeholder-webhook-secret";

process.env.STRIPE_SECRET_KEY = PLACEHOLDER_KEY;
process.env.STRIPE_WEBHOOK_SECRET = PLACEHOLDER_SECRET;
delete process.env.ORDER_EMAIL_PROVIDER;
delete process.env.ORDER_EMAIL_FROM;
delete process.env.ORDER_EMAIL_REPLY_TO;
delete process.env.ORDER_EMAIL_BCC;
delete process.env.GMAIL_IMPERSONATE;
delete process.env.GMAIL_SERVICE_ACCOUNT_JSON;

function memoryStore() {
  const data = new Map();
  return {
    async get(key) {
      if (!data.has(key)) return null;
      return JSON.parse(JSON.stringify(data.get(key)));
    },
    async setJSON(key, value) {
      data.set(key, JSON.parse(JSON.stringify(value)));
    },
  };
}

const orders = memoryStore();
const subs = memoryStore();
const blobs = require(path.join(ROOT, "netlify/functions/lib/blobs.js"));
blobs.ordersStore = () => orders;
blobs.subsStore = () => subs;
blobs.setJson = async (store, key, value) => store.setJSON(key, value);

const { handler } = require(path.join(ROOT, "netlify/functions/stripe-webhook.js"));
const email = require(path.join(ROOT, "netlify/functions/lib/email.js"));
const copy = require(path.join(ROOT, "netlify/functions/lib/order-confirmation.js"));
const { getStripe } = require(path.join(ROOT, "netlify/functions/lib/stripe-client.js"));
const stripe = getStripe();

const logs = [];
const realLog = console.log;
const realError = console.error;
console.log = (...args) => logs.push(args.join(" "));
console.error = (...args) => logs.push(args.join(" "));

let passed = 0;
function check(cond, msg) {
  assert.ok(cond, msg);
  passed++;
}

const sent = [];
function captureTransport() {
  sent.length = 0;
  email.setTransportForTests(async (envelope) => {
    sent.push(envelope);
    return { ok: true, id: "msg_test" };
  });
}

function sign(body) {
  return stripe.webhooks.generateTestHeaderString({ payload: body, secret: PLACEHOLDER_SECRET });
}

function post(body) {
  return handler({
    httpMethod: "POST",
    headers: { "stripe-signature": sign(body) },
    body,
  });
}

function eventBody(type, object, id) {
  return JSON.stringify({
    id: id || `evt_${type}_${object.id || "x"}`,
    object: "event",
    type,
    data: { object },
  });
}

function paidSession(overrides = {}) {
  const metadata = overrides.metadata || {
    leadTypeLabel: "General Life",
    ageBandLabel: "Under 30 days",
    quantity: "2500",
    states: "FL,TX",
    billingCadence: "one-time",
  };
  return {
    id: "cs_paid_1",
    object: "checkout.session",
    mode: "payment",
    payment_status: "paid",
    amount_total: 130000,
    currency: "usd",
    created: Math.floor(Date.parse("2026-10-26T16:00:00.000Z") / 1000),
    customer_email: "buyer@example.com",
    ...overrides,
    metadata,
  };
}

(async () => {
  process.env.ORDER_EMAIL_FROM = "Lead Reload HQ <support@leadreloadhq.com>";
  process.env.ORDER_EMAIL_REPLY_TO = "support@leadreloadhq.com";
  delete process.env.ORDER_EMAIL_BCC;

  const view = copy.orderViewFromSession(paidSession(), "support@leadreloadhq.com");
  check(view.product === "General Life", "product");
  check(view.leadCount === "2,500", "lead count");
  check(view.ageRange === "Under 30 days", "age range");
  check(view.states === "FL, TX", "states");
  check(view.amount === "$1,300.00 USD", "amount");
  check(view.orderDate === "October 26, 2026 (ET)", `order date ${view.orderDate}`);
  check(view.reference === "cs_paid_1", "reference");

  const built = copy.buildOrderConfirmation(view);
  check(built.subject === "Your Lead Reload HQ order is confirmed", "subject");
  check(built.text.includes("Thank you for your order."), "thanks");
  check(built.text.includes("Product: General Life"), "text product");
  check(built.text.includes("Lead count: 2,500"), "text qty");
  check(built.text.includes("Age range: Under 30 days"), "text age");
  check(built.text.includes("States: FL, TX"), "text states");
  check(built.text.includes("Billing: One-time purchase"), "text billing");
  check(built.text.includes("This is a single charge and does not renew."), "one-time detail");
  check(built.text.includes("Amount paid: $1,300.00 USD"), "text amount");
  check(built.text.includes("Order date: October 26, 2026 (ET)"), "text date");
  check(built.text.includes("WHAT HAPPENS NEXT"), "next heading");
  check(
    built.text.includes("Fulfillment follows the state and age-band selection on this order."),
    "fulfillment sentence"
  );
  check(built.text.includes("EXPECTED DELIVERY TIMELINE"), "timeline heading");
  check(built.text.includes(copy.DELIVERY_TIMELINE_PLACEHOLDER), "timeline placeholder");
  check(built.text.includes("Questions: reply to this email, or write to support@leadreloadhq.com."), "contact");
  check(built.text.includes("Lead Reload HQ"), "brand");
  check(built.text.includes("https://leadreloadhq.com"), "url");
  check(built.html.includes("text/html") === false, "html is a document, not a mime header");
  check(built.html.includes("<html"), "html document");
  check(built.html.includes(copy.DELIVERY_TIMELINE_PLACEHOLDER), "html placeholder");
  check(!built.subject.includes("\u2014") && !built.text.includes("\u2014") && !built.html.includes("\u2014"), "no em dash");
  check(!built.text.includes("\u2013") && !built.html.includes("\u2013"), "no en dash in this sample");
  check(!/exclusiv|opt-?in|consent|tcpa/i.test(built.text), "no banned claims");

  const weekly = copy.buildOrderConfirmation({
    ...view,
    billingCadence: "weekly",
  });
  check(weekly.text.includes("Billing: Weekly subscription"), "weekly label");
  check(weekly.text.includes("every week until you cancel"), "weekly detail");
  const monthly = copy.buildOrderConfirmation({ ...view, billingCadence: "monthly" });
  check(monthly.text.includes("Billing: Monthly subscription"), "monthly label");
  check(monthly.text.includes("every month until you cancel"), "monthly detail");

  const noSupport = copy.buildOrderConfirmation({ ...view, supportEmail: "" });
  check(noSupport.text.includes(copy.CONTACT_PLACEHOLDER), "contact placeholder");

  const injected = copy.buildOrderConfirmation({
    ...view,
    product: `<script>alert("x")</script>`,
    states: `TX & FL`,
  });
  check(!injected.html.includes("<script>"), "html escapes product");
  check(injected.html.includes("&lt;script&gt;"), "escaped script tag");
  check(injected.html.includes("TX &amp; FL"), "escapes ampersand");
  check(injected.text.includes(`<script>alert("x")</script>`), "plain text keeps the characters");

  const noAge = copy.orderViewFromSession(
    paidSession({ metadata: { leadTypeLabel: "Business Owner Raw Data", quantity: "35000", states: "FL", billingCadence: "one-time" } }),
    "support@leadreloadhq.com"
  );
  check(noAge.ageRange === "Not applicable", "missing age band");
  check(noAge.leadCount === "35,000", "record count");

  const src = fs.readFileSync(path.join(ROOT, "netlify/functions/lib/order-confirmation.js"), "utf8");
  check(!src.includes("\u2014"), "confirmation source has no em dash");

  // --- Webhook rules -------------------------------------------------------
  captureTransport();
  const paidBody = eventBody("checkout.session.completed", paidSession(), "evt_paid_1");

  let r = await post(paidBody);
  check(r.statusCode === 200 && r.body === "ok", `paid -> ${r.statusCode} ${r.body}`);
  check(sent.length === 1, "one send");
  check(sent[0].subject === copy.SUBJECT, "sent subject");
  check(sent[0].to === "buyer@example.com", "sent to");
  check(sent[0].replyTo === "support@leadreloadhq.com", "reply-to");
  check(sent[0].from === "Lead Reload HQ <support@leadreloadhq.com>", "from");
  check(sent[0].bcc.length === 0, "bcc off by default");
  check(sent[0].text.includes("General Life") && sent[0].html.includes("General Life"), "both bodies");
  check(sent[0].idempotencyKey === "order-confirmation:cs_paid_1", "idempotency key");
  let stored = await orders.get("cs_paid_1");
  check(stored && stored.confirmationEmail.status === "sent", "marked sent");
  check(stored.confirmationEmail.messageId === "msg_test", "message id stored");
  check(stored.status === "open", "new order stays open");
  check(stored.email === "buyer@example.com", "order email stored");

  r = await post(paidBody);
  check(r.statusCode === 200, "retry 200");
  check(sent.length === 1, "retry does not send again");

  stored = await orders.get("cs_paid_1");
  stored.status = "fulfilled";
  stored.fulfilledAt = "2026-10-26T18:00:00.000Z";
  await orders.setJSON("cs_paid_1", stored);
  r = await post(paidBody);
  check(r.statusCode === 200, "replay after fulfill 200");
  stored = await orders.get("cs_paid_1");
  check(stored.status === "fulfilled", "fulfilled status kept");
  check(stored.fulfilledAt === "2026-10-26T18:00:00.000Z", "fulfilledAt kept");
  check(sent.length === 1, "fulfilled replay does not email again");

  const unpaid = paidSession({ id: "cs_unpaid", payment_status: "unpaid" });
  r = await post(eventBody("checkout.session.completed", unpaid, "evt_unpaid"));
  check(r.statusCode === 200, "unpaid 200");
  check(sent.length === 1, "unpaid does not email");
  stored = await orders.get("cs_unpaid");
  check(stored && stored.email === "buyer@example.com", "unpaid order still stored");
  check(stored.confirmationEmail == null, "unpaid has no email status");

  const none = paidSession({ id: "cs_none", payment_status: "no_payment_required" });
  r = await post(eventBody("checkout.session.completed", none, "evt_none"));
  check(sent.length === 1, "no_payment_required does not email");

  const missingStatus = paidSession({ id: "cs_nostatus" });
  delete missingStatus.payment_status;
  r = await post(eventBody("checkout.session.completed", missingStatus, "evt_nostatus"));
  check(sent.length === 1, "missing payment_status does not email");
  check(await orders.get("cs_nostatus"), "order without payment_status is still stored");

  r = await post(eventBody("checkout.session.expired", paidSession({ id: "cs_expired" }), "evt_expired"));
  check(r.statusCode === 200, "expired 200");
  check(!(await orders.get("cs_expired")), "expired not stored");
  check(sent.length === 1, "expired does not email");

  r = await handler({ httpMethod: "POST", headers: {}, body: paidBody });
  check(r.statusCode === 400 && r.body === "missing_signature", "unsigned paid event rejected");
  check(sent.length === 1, "unsigned event does not email");

  const delayed = paidSession({ id: "cs_async" });
  r = await post(eventBody("checkout.session.async_payment_succeeded", delayed, "evt_async"));
  check(r.statusCode === 200, "async paid 200");
  check(sent.length === 2, "async paid sends");
  check((await orders.get("cs_async")).confirmationEmail.status === "sent", "async marked sent");

  const subSession = paidSession({
    id: "cs_sub_1",
    mode: "subscription",
    subscription: "sub_123",
    metadata: { billingCadence: "weekly", quantity: "500", states: "TX", leadTypeLabel: "Private Health", ageBandLabel: "30-60 days" },
  });
  const subBody = eventBody("checkout.session.completed", subSession, "evt_sub");
  r = await post(subBody);
  check(r.statusCode === 200, "subscription 200");
  check(sent.length === 3, "subscription emails once");
  check(sent[2].text.includes("Weekly subscription"), "weekly copy sent");
  check(!(await orders.get("cs_sub_1")), "subscription is not an order row");
  check((await subs.get("sub_123")).confirmationEmail.status === "sent", "sub email marked on the subscription");
  r = await post(subBody);
  check(sent.length === 3, "subscription retry does not email again");

  r = await post(eventBody("invoice.paid", { id: "in_1", subscription: "sub_123", customer: "cus_1" }, "evt_inv"));
  check(r.statusCode === 200, "invoice.paid 200");
  check(sent.length === 3, "renewal invoice does not email");
  check((await subs.get("sub_123")).lastInvoiceId === "in_1", "renewal still recorded");

  email.setTransportForTests(async () => {
    throw new Error("mailbox unavailable");
  });
  const boom = paidSession({ id: "cs_boom" });
  r = await post(eventBody("checkout.session.completed", boom, "evt_boom"));
  check(r.statusCode === 200 && r.body === "ok", "email throw still 200");
  stored = await orders.get("cs_boom");
  check(stored && stored.email === "buyer@example.com", "order stored when email throws");
  check(stored.status === "open", "order status kept when email throws");
  check(stored.confirmationEmail.status === "failed", "failure recorded");
  check(logs.some((line) => line.includes("order was saved") || line.includes("email_send_failed") || line.includes("mailbox unavailable")), "failure logged");

  let attempts = 0;
  email.setTransportForTests(async () => {
    attempts += 1;
    if (attempts === 1) throw new Error("temporary");
    return { ok: true, id: "msg_retry" };
  });
  const retrySession = paidSession({ id: "cs_retry" });
  const retryBody = eventBody("checkout.session.completed", retrySession, "evt_retry");
  await post(retryBody);
  await post(retryBody);
  check(attempts === 2, "failed send can be retried by a later delivery");
  check((await orders.get("cs_retry")).confirmationEmail.status === "sent", "retry then sent");

  email.setTransportForTests(async () => {
    throw new Error("should not send while locked");
  });
  const locked = paidSession({ id: "cs_lock" });
  await orders.setJSON("cs_lock", {
    id: "cs_lock",
    status: "open",
    email: "buyer@example.com",
    confirmationEmail: { status: "sending", sessionId: "cs_lock", at: new Date().toISOString() },
  });
  r = await post(eventBody("checkout.session.completed", locked, "evt_lock"));
  check(r.statusCode === 200, "in-flight lock still 200");
  check((await orders.get("cs_lock")).confirmationEmail.status === "sending", "lock holds");

  const origSet = orders.setJSON.bind(orders);
  orders.setJSON = async () => {
    throw new Error("disk");
  };
  let diskSends = 0;
  email.setTransportForTests(async () => {
    diskSends += 1;
    return { ok: true, id: "should-not-send" };
  });
  r = await post(eventBody("checkout.session.completed", paidSession({ id: "cs_disk" }), "evt_disk"));
  check(r.statusCode === 500 && r.body === "handler_error", "storage failure is still 500");
  orders.setJSON = origSet;
  check(diskSends === 0, "email not attempted when the order was not saved");

  delete process.env.ORDER_EMAIL_FROM;
  delete process.env.ORDER_EMAIL_REPLY_TO;
  email.setTransportForTests(null);
  const bare = paidSession({ id: "cs_noconfig" });
  r = await post(eventBody("checkout.session.completed", bare, "evt_noconfig"));
  check(r.statusCode === 200, "unconfigured email still 200");
  stored = await orders.get("cs_noconfig");
  check(stored.confirmationEmail.status === "skipped", "skipped when email is not configured");
  check(stored.confirmationEmail.reason === "email_not_configured", "reason email_not_configured");

  const ghost = paidSession({ id: "cs_ghost", customer_email: "" });
  process.env.ORDER_EMAIL_FROM = "Lead Reload HQ <support@leadreloadhq.com>";
  captureTransport();
  r = await post(eventBody("checkout.session.completed", ghost, "evt_ghost"));
  check(r.statusCode === 200, "missing buyer email still 200");
  check(sent.length === 0, "no send without a buyer email");
  check((await orders.get("cs_ghost")).confirmationEmail.reason === "no_recipient", "no_recipient");

  process.env.ORDER_EMAIL_BCC = " ops@example.com, not-an-email, zac@example.com ";
  captureTransport();
  r = await post(eventBody("checkout.session.completed", paidSession({ id: "cs_bcc" }), "evt_bcc"));
  check(sent.length === 1, "bcc order sends");
  check(sent[0].bcc.join(",") === "ops@example.com,zac@example.com", `bcc parsed: ${sent[0].bcc}`);
  check(!sent[0].text.includes("ops@example.com"), "bcc is not in the buyer body");

  // --- Gmail API provider (stubbed HTTPS) ----------------------------------
  email.setTransportForTests(null);
  delete process.env.ORDER_EMAIL_BCC;
  const { privateKey, publicKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
  const pem = privateKey.export({ type: "pkcs8", format: "pem" });
  const serviceJson = JSON.stringify({
    client_email: "mailer@lead-reload-hq-mail.iam.gserviceaccount.com",
    private_key: pem,
    client_id: "1234567890",
  });
  process.env.ORDER_EMAIL_PROVIDER = "gmail-api";
  process.env.ORDER_EMAIL_FROM = "Lead Reload HQ <support@leadreloadhq.com>";
  process.env.ORDER_EMAIL_REPLY_TO = "support@leadreloadhq.com";
  process.env.GMAIL_SERVICE_ACCOUNT_JSON = Buffer.from(serviceJson).toString("base64");

  const settings = email.resolveEmailSettings();
  check(settings.configured === true, "base64 service account configures gmail-api");
  check(settings.impersonate === "support@leadreloadhq.com", "impersonate defaults from From");
  check(settings.replyTo === "support@leadreloadhq.com", "reply-to");
  check(settings.bcc.length === 0, "no bcc");
  check(!JSON.stringify(settings.missing || []).includes("GMAIL_IMPERSONATE"), "impersonate not required when From has an address");

  const calls = [];
  const realFetch = global.fetch;
  global.fetch = async (url, opts) => {
    calls.push({ url: String(url), opts });
    if (String(url).includes("oauth2.googleapis.com")) {
      return { ok: true, status: 200, async text() { return JSON.stringify({ access_token: "ya29.test" }); } };
    }
    return { ok: true, status: 200, async text() { return JSON.stringify({ id: "gmail_msg_1" }); } };
  };

  const sendResult = await email.sendEmail({
    to: "buyer@example.com",
    subject: copy.SUBJECT,
    text: built.text,
    html: built.html,
    idempotencyKey: "order-confirmation:cs_paid_1",
  });
  check(sendResult.ok === true && sendResult.id === "gmail_msg_1", `gmail send result ${JSON.stringify(sendResult)}`);
  check(calls.length === 2, "token then send");
  check(calls[0].url === email.TOKEN_URL, "token url");
  const tokenParams = new URLSearchParams(calls[0].opts.body);
  check(tokenParams.get("grant_type") === "urn:ietf:params:oauth:grant-type:jwt-bearer", "jwt bearer grant");
  const assertion = tokenParams.get("assertion");
  const [h, p, s] = assertion.split(".");
  const claims = JSON.parse(Buffer.from(p, "base64url").toString("utf8"));
  check(claims.iss === "mailer@lead-reload-hq-mail.iam.gserviceaccount.com", "jwt iss");
  check(claims.sub === "support@leadreloadhq.com", "jwt sub is the mailbox");
  check(claims.scope === email.GMAIL_SEND_SCOPE, "send-only scope");
  check(claims.aud === email.TOKEN_URL, "jwt aud");
  const verified = crypto.createVerify("RSA-SHA256").update(`${h}.${p}`).verify(publicKey, Buffer.from(s, "base64url"));
  check(verified, "jwt signature verifies");
  check(calls[1].url === "https://gmail.googleapis.com/gmail/v1/users/support%40leadreloadhq.com/messages/send", `send url ${calls[1].url}`);
  check(calls[1].opts.headers.Authorization === "Bearer ya29.test", "bearer token");
  const raw = JSON.parse(calls[1].opts.body).raw;
  const mime = Buffer.from(raw, "base64url").toString("utf8");
  const decodedBodies = mime
    .split(/Content-Transfer-Encoding: base64\r\n\r\n/)
    .slice(1)
    .map((part) => Buffer.from(part.split(/\r\n--/)[0].replace(/\s+/g, ""), "base64").toString("utf8"))
    .join("\n");
  check(mime.includes("From: Lead Reload HQ <support@leadreloadhq.com>"), "mime from");
  check(mime.includes("To: buyer@example.com"), "mime to");
  check(mime.includes("Reply-To: support@leadreloadhq.com"), "mime reply-to");
  check(mime.includes("Subject: Your Lead Reload HQ order is confirmed"), "mime subject");
  check(mime.includes("Content-Type: text/plain; charset=UTF-8"), "plain part");
  check(mime.includes("Content-Type: text/html; charset=UTF-8"), "html part");
  check(decodedBodies.includes("Thank you for your order."), "decoded body includes the plain text");
  check(decodedBodies.includes("<html"), "decoded body includes the html");
  check(!mime.includes("BEGIN PRIVATE KEY"), "mime does not contain the private key");
  check(!calls[1].opts.body.includes("BEGIN PRIVATE KEY"), "request body does not contain the private key");
  check(!mime.includes("Bcc:"), "no bcc header by default");

  calls.length = 0;
  process.env.ORDER_EMAIL_BCC = "ops@example.com";
  global.fetch = async (url) => {
    calls.push(String(url));
    if (String(url).includes("oauth2.googleapis.com")) {
      return { ok: false, status: 401, async text() { return JSON.stringify({ error: "invalid_grant", error_description: "delegation missing" }); } };
    }
    throw new Error("send should not run");
  };
  const denied = await email.sendEmail({ to: "buyer@example.com", subject: "S", text: "t", html: "<p>t</p>" });
  check(denied.ok === false && denied.reason === "email_send_failed", "token failure");
  check(String(denied.message).includes("delegation missing"), "token error message");
  check(calls.length === 1, "no gmail call after token failure");

  process.env.ORDER_EMAIL_PROVIDER = "off";
  let fetched = 0;
  global.fetch = async () => {
    fetched += 1;
    throw new Error("should not fetch");
  };
  const off = await email.sendEmail({ to: "buyer@example.com", subject: "S", text: "t", html: "<p>t</p>" });
  check(off.skipped === true && off.reason === "email_disabled", "provider off skips");
  check(fetched === 0, "off does not call Gmail");

  process.env.ORDER_EMAIL_PROVIDER = "gmail-smtp";
  const smtp = await email.sendEmail({ to: "buyer@example.com", subject: "S", text: "t", html: "<p>t</p>" });
  check(smtp.skipped === true && smtp.reason === "unsupported_provider", "smtp is not the built-in provider");
  check(fetched === 0, "unsupported provider does not call Gmail");

  delete process.env.ORDER_EMAIL_FROM;
  delete process.env.GMAIL_IMPERSONATE;
  delete process.env.GMAIL_SERVICE_ACCOUNT_JSON;
  process.env.ORDER_EMAIL_PROVIDER = "gmail-api";
  const missing = await email.sendEmail({ to: "buyer@example.com", subject: "S", text: "t", html: "<p>t</p>" });
  check(missing.skipped === true && missing.reason === "email_not_configured", "missing env skips");
  check(missing.missing.includes("ORDER_EMAIL_FROM"), "names ORDER_EMAIL_FROM");
  check(missing.missing.includes("GMAIL_SERVICE_ACCOUNT_JSON"), "names the key env");
  check(fetched === 0, "unconfigured does not call Gmail");

  email.setTransportForTests(async (envelope) => {
    sent.push(envelope);
    return { ok: true };
  });
  sent.length = 0;
  await email.sendEmail({ to: "buyer@example.com\r\nBcc: evil@example.com", subject: "Hi\r\nBcc: evil@example.com", text: "t", html: "<p>t</p>" });
  check(!sent[0].to.includes("\n") && !sent[0].to.includes("evil@"), "to header cannot inject");
  check(!sent[0].subject.includes("\n"), "subject header cannot inject");

  global.fetch = realFetch;
  email.setTransportForTests(null);

  const docNames = ["ORDER_EMAIL.md", ".env.example", "PROJECT_BRIEF.md", "STRIPE_SETUP.md"];
  const docs = Object.fromEntries(docNames.map((name) => [name, fs.readFileSync(path.join(ROOT, name), "utf8")]));
  for (const envName of email.ENV_NAMES) {
    for (const name of docNames) {
      check(docs[name].includes(envName), `${name} documents ${envName}`);
    }
  }
  const setup = docs["ORDER_EMAIL.md"];
  check(setup.includes("smtp.google.com"), "MX host documented");
  check(setup.includes("v=spf1 include:_spf.google.com ~all"), "SPF documented");
  check(setup.includes("gmail.send"), "scope documented");
  check(setup.includes("support@leadreloadhq.com"), "mailbox documented");
  check(setup.includes("p=quarantine"), "current DMARC policy documented");
  check(setup.includes("dmarc_rua@onsecureserver.net"), "current DMARC rua documented");
  check(setup.includes("75.2.60.5"), "website A record called out");
  check(/do not (change|replace) the nameservers/i.test(setup), "nameserver warning");
  check(setup.includes("preview-order-email.js"), "preview script documented");
  check(!setup.includes("\u2014"), "setup doc has no em dash");

  console.log = realLog;
  console.error = realError;
  console.log(`PASS — order confirmation email: ${passed} assertions`);
})().catch((err) => {
  console.log = realLog;
  console.error = realError;
  console.error("FAIL:", err && err.stack ? err.stack : err);
  if (logs.length) console.error(logs.slice(-30).join("\n"));
  process.exit(1);
});

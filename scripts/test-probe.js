#!/usr/bin/env node
/* eslint-disable no-console */
"use strict";

/**
 * Storefront checkout-gate tests for public/app.js. No jsdom, no network:
 * runs the whole app.js in a vm sandbox with a tiny fake DOM, fake
 * localStorage (to seed a saved cart) and a stubbed fetch.
 *
 *   node scripts/test-probe.js      (or: npm run test:probe)
 *
 * Covers:
 *  - Stripe probe: {ok:true, configured:true} enables the Pay button;
 *    stripe_not_configured / network error / empty reply keep it disabled.
 *  - Minimum order: totals under $0.50 show "Minimum order is $0.50. Add more
 *    leads." and never call create-checkout; a server amount_too_small reply
 *    shows the same message instead of the raw reason.
 *  - Success copy (static HTML + the ?checkout=success message) no longer
 *    points to the disabled customer portal; it says to reply to the receipt
 *    email or contact us. No volume-discount wording in index.html.
 *  - A saved cart with a retired age band (ph-90-180, ph-180-360, lm-90) is
 *    cleared back to the Age step; new 90–365 bands show the right total.
 */

const fs = require("fs");
const path = require("path");
const vm = require("vm");
const assert = require("assert");

const ROOT = path.resolve(__dirname, "..");
const APP_SRC = fs.readFileSync(path.join(ROOT, "public/app.js"), "utf8");
const HTML_SRC = fs.readFileSync(path.join(ROOT, "public/index.html"), "utf8");
const pricing = require(path.join(ROOT, "netlify/functions/lib/pricing.js"));
const SUB_HELP = "To cancel or change a subscription, reply to your receipt email or contact us.";
const MIN_MSG = "Minimum order is $0.50. Add more leads.";
const OFFLINE = "Payments coming online tonight";

function makeClassList() {
  const set = new Set();
  return {
    add: (...c) => c.forEach((x) => set.add(x)),
    remove: (...c) => c.forEach((x) => set.delete(x)),
    toggle: (c, force) => {
      const on = force === undefined ? !set.has(c) : !!force;
      if (on) set.add(c);
      else set.delete(c);
      return on;
    },
    contains: (c) => set.has(c),
  };
}

function makeElement(id) {
  const listeners = {};
  return {
    id,
    textContent: "",
    innerHTML: "",
    value: "",
    disabled: false,
    hidden: false,
    checked: false,
    title: "",
    dataset: {},
    offsetWidth: 0,
    classList: makeClassList(),
    setAttribute() {},
    querySelectorAll: () => [],
    addEventListener(type, fn) {
      (listeners[type] = listeners[type] || []).push(fn);
    },
    dispatchEvent(evt) {
      return (listeners[evt.type] || []).map((fn) => fn(evt));
    },
    // test helper: run listeners and wait for async handlers
    async fire(type) {
      await Promise.all((listeners[type] || []).map((fn) => fn({ type })));
    },
  };
}

/**
 * Boot app.js with a saved cart and scripted fetch replies.
 * probe / checkout: reply object, or an Error to simulate a network failure.
 */
async function boot({ draft, probe, checkout, search = "" }) {
  const elements = {};
  const getEl = (id) => (elements[id] = elements[id] || makeElement(id));
  const store = { "lead-reload-draft": JSON.stringify(draft) };
  const calls = [];
  const contactBox = { value: "Dialer", checked: true };

  const fetch = async (url, opts) => {
    const body = JSON.parse(opts.body);
    calls.push({ url, body });
    const reply = body.probe === true ? probe : checkout;
    if (reply instanceof Error) throw reply;
    return { json: async () => reply };
  };

  const window = {
    location: { search, pathname: "/", href: "/" },
    history: { replaceState() {} },
    matchMedia: () => ({ matches: false }),
    addEventListener() {},
    scrollTo() {},
  };
  const document = {
    readyState: "complete",
    body: { classList: makeClassList() },
    getElementById: getEl,
    querySelector: () => null,
    querySelectorAll: (sel) =>
      sel === 'input[name="contactMethod"]:checked' ? [contactBox] : [],
    addEventListener() {},
  };
  const sandbox = {
    window,
    document,
    fetch,
    localStorage: {
      getItem: (k) => (k in store ? store[k] : null),
      setItem: (k, v) => (store[k] = String(v)),
      removeItem: (k) => delete store[k],
    },
    requestAnimationFrame: () => 0,
    setTimeout,
    clearTimeout,
    Event: class Event {
      constructor(type) {
        this.type = type;
      }
    },
    URLSearchParams,
    console,
  };
  vm.runInNewContext(APP_SRC, sandbox, { filename: "public/app.js" });
  await new Promise((r) => setImmediate(r)); // let the async probe settle
  return { el: getEl, calls, window, store };
}

const baseDraft = {
  step: 5,
  leadType: "general-life",
  ageBandId: "lm-u30",
  quantity: 100,
  states: ["FL"],
  billingCadence: "one-time",
  contactMethods: ["Dialer"],
  contactOther: "",
};
const LIVE = { ok: true, configured: true };

let passed = 0;
function check(cond, msg) {
  assert.ok(cond, msg);
  passed++;
}

async function pay(env, email = "buyer@example.com") {
  env.el("pay-email").value = email;
  await env.el("pay-btn").fire("click");
}

(async () => {
  // ——— Probe ———
  let env = await boot({ draft: baseDraft, probe: LIVE });
  let btn = env.el("pay-btn");
  check(btn.disabled === false, "live probe must enable Pay");
  check(btn.innerHTML.includes("Continue to Stripe") && btn.innerHTML.includes("$52.00"), `pay label: ${btn.innerHTML}`);
  check(env.el("pay-status-chip").textContent === "Secure Stripe checkout", "chip live");
  check(env.el("pay-offline-banner").hidden === true, "offline banner hidden");
  check(env.calls.length === 1 && env.calls[0].body.probe === true, "one probe call");

  for (const [label, probe] of [
    ["stripe_not_configured", { ok: false, reason: "stripe_not_configured" }],
    ["network error", new Error("offline")],
    ["empty reply", {}],
    ["ok without configured/url", { ok: true }],
  ]) {
    env = await boot({ draft: baseDraft, probe });
    btn = env.el("pay-btn");
    check(btn.disabled === true, `${label}: Pay must stay disabled`);
    check(btn.innerHTML === OFFLINE, `${label}: button text ${btn.innerHTML}`);
    check(env.el("pay-offline-banner").hidden === false, `${label}: offline banner shown`);
    // Clicking Pay while offline never calls create-checkout
    await pay(env);
    check(env.calls.length === 1, `${label}: no checkout call`);
  }

  // Legacy behaviour kept: validation reason (key present) → enabled
  env = await boot({ draft: baseDraft, probe: { ok: false, reason: "invalid_cart" } });
  check(env.el("pay-btn").disabled === false, "invalid_cart probe → enabled");

  // ——— Minimum order ———
  // 16 × $0.03 = $0.48 → blocked client-side
  env = await boot({ draft: { ...baseDraft, ageBandId: "lm-365", quantity: 16 }, probe: LIVE, checkout: { ok: true, url: "https://checkout.stripe.test/x" } });
  await pay(env);
  check(env.el("pay-error").textContent === MIN_MSG, `min msg: ${env.el("pay-error").textContent}`);
  check(env.el("pay-error").classList.contains("hidden") === false, "min msg visible");
  check(env.calls.length === 1, "no create-checkout call under $0.50");
  check(env.window.location.href === "/", "no redirect");

  // 1 × $0.39 = $0.39 → blocked
  env = await boot({ draft: { ...baseDraft, ageBandId: "lm-30-60", quantity: 1 }, probe: LIVE, checkout: { ok: true, url: "https://checkout.stripe.test/x" } });
  await pay(env);
  check(env.el("pay-error").textContent === MIN_MSG && env.calls.length === 1, "$0.39 blocked");

  // 17 × $0.03 = $0.51 → goes to Stripe with the same payload as before
  env = await boot({ draft: { ...baseDraft, ageBandId: "lm-365", quantity: 17 }, probe: LIVE, checkout: { ok: true, url: "https://checkout.stripe.test/x", sessionId: "cs_x" } });
  await pay(env);
  check(env.calls.length === 2, "checkout called at $0.51");
  const body = env.calls[1].body;
  check(env.calls[1].url === "/.netlify/functions/create-checkout", "checkout url");
  check(body.leadType === "general-life" && body.ageBandId === "lm-365" && body.quantity === 17 && body.unitPrice === 0.03, "payload");
  check(env.window.location.href === "https://checkout.stripe.test/x", "redirect to Stripe");
  check(env.el("pay-error").textContent === "", "no error");

  // Server still says amount_too_small → friendly message, not the raw reason
  env = await boot({ draft: baseDraft, probe: LIVE, checkout: { ok: false, reason: "amount_too_small" } });
  await pay(env);
  check(env.el("pay-error").textContent === MIN_MSG, `server amount_too_small → ${env.el("pay-error").textContent}`);
  check(env.el("pay-btn").disabled === false, "button re-enabled after error");

  // Other server errors still surface as before
  env = await boot({ draft: baseDraft, probe: LIVE, checkout: { ok: false, reason: "invalid_age_band" } });
  await pay(env);
  check(env.el("pay-error").textContent === "invalid_age_band", "other reasons unchanged");

  // ——— Success copy: no customer portal ———
  env = await boot({ draft: baseDraft, probe: LIVE, search: "?checkout=success&session_id=cs_test_ok" });
  const successCopy = env.el("success-copy").textContent;
  check(successCopy.length > 0, "success copy rendered");
  check(!/portal/i.test(successCopy), `success copy still mentions the portal: ${successCopy}`);
  check(successCopy.includes(SUB_HELP), `success copy missing subscription help: ${successCopy}`);
  check(env.el("order-id").textContent === "cs_test_ok", "order reference shown");
  const staticCopy = (HTML_SRC.match(/<p id="success-copy">([\s\S]*?)<\/p>/) || [])[1] || "";
  check(staticCopy.includes(SUB_HELP) && !/portal/i.test(staticCopy), `static success copy: ${staticCopy}`);
  check(!/portal/i.test(HTML_SRC), "index.html must not mention the customer portal");
  check(!/volume buyers|volume &amp; custom programs|discount/i.test(HTML_SRC), "index.html must not imply volume discounts");

  // ——— Age bands (2026-09-25) ———
  // Saved carts with retired bands are sent back to the Age step with no band.
  for (const [leadType, ageBandId] of [["private-health", "ph-90-180"], ["private-health", "ph-180-360"], ["general-life", "lm-90"], ["mortgage-protection", "lm-90"]]) {
    env = await boot({ draft: { ...baseDraft, leadType, ageBandId }, probe: LIVE, checkout: { ok: true, url: "https://checkout.stripe.test/x" } });
    const saved = JSON.parse(env.store["lead-reload-draft"]);
    check(saved.ageBandId === null && saved.step === 2, `retired ${ageBandId}: draft ${JSON.stringify(saved)}`);
  }
  // New 90–365 bands price correctly (Private Health uses PRIVATE_HEALTH_90_365).
  for (const [leadType, ageBandId, cents] of [
    ["general-life", "lm-90-365", 1000],
    ["private-health", "ph-90-365", Math.round(pricing.PRIVATE_HEALTH_90_365 * 100) * 100],
  ]) {
    env = await boot({ draft: { ...baseDraft, leadType, ageBandId }, probe: LIVE });
    const want = "$" + (cents / 100).toFixed(2);
    check(env.el("pay-btn").innerHTML.includes(want), `${ageBandId} × 100 → ${env.el("pay-btn").innerHTML} (want ${want})`);
    check(env.el("prev-age").textContent === "90–365 days", `${ageBandId} label`);
  }

  console.log(`PASS — storefront probe + minimum order + success copy + age bands: ${passed} assertions`);
})().catch((err) => {
  console.error("FAIL:", err && err.message ? err.message : err);
  process.exit(1);
});

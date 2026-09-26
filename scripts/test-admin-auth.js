#!/usr/bin/env node
/* eslint-disable no-console */
"use strict";

/**
 * Admin auth (Netlify Identity) tests. No network, no real tokens.
 * Netlify puts the verified Identity user on context.clientContext.user;
 * here we pass a fake clientContext instead.
 *
 *   node scripts/test-admin-auth.js      (or: npm run test:admin)
 *
 * Every netlify/functions/admin-*.js must:
 *   - return 401 with no Identity user (and never touch storage),
 *   - return 403 for a signed-in user whose email is not allowlisted,
 *   - accept both allowlisted emails (case-insensitive).
 * Also checks the shared password gate is gone and the Identity link
 * forwarding on the site root.
 */

const fs = require("fs");
const path = require("path");
const vm = require("vm");
const assert = require("assert");

const ROOT = path.resolve(__dirname, "..");
const FN_DIR = path.join(ROOT, "netlify/functions");

let passed = 0;
function check(cond, msg) {
  assert.ok(cond, msg);
  passed++;
}

// Stub Netlify Blobs before any admin function destructures it.
let storeCalls = 0;
const ORDER = { id: "cs_test_order", status: "open", email: "buyer@example.com" };
const blobs = require(path.join(FN_DIR, "lib/blobs.js"));
const fakeStore = (name) => ({
  name,
  list: async () => {
    storeCalls++;
    return { blobs: [{ key: "k1" }] };
  },
  get: async (key) => {
    storeCalls++;
    if (name === "orders" && key === ORDER.id) return { ...ORDER };
    return name === "orders" ? { ...ORDER } : { id: "sub_test", status: "active" };
  },
  setJSON: async () => {
    storeCalls++;
  },
});
blobs.ordersStore = () => fakeStore("orders");
blobs.subsStore = () => fakeStore("subs");
blobs.setJson = async (store, key, value) => store.setJSON(key, value);

const auth = require(path.join(FN_DIR, "lib/auth.js"));

// --- The allowlist constant -------------------------------------------------
const EXPECTED = ["dwhigham94@gmail.com", "zacfischer10x@gmail.com"];
check(
  JSON.stringify([...auth.ADMIN_EMAILS].sort()) === JSON.stringify([...EXPECTED].sort()),
  `ADMIN_EMAILS must be exactly ${EXPECTED.join(", ")}`
);
check(Object.isFrozen(auth.ADMIN_EMAILS), "ADMIN_EMAILS is frozen");
check(
  auth.ADMIN_EMAILS.every((e) => e === e.trim().toLowerCase()),
  "ADMIN_EMAILS entries are lowercase"
);
check(auth.isAllowedEmail(" DWhigham94@Gmail.com "), "case/whitespace-insensitive");
check(!auth.isAllowedEmail(""), "empty email rejected");
check(!auth.isAllowedEmail("dwhigham94@gmail.com.evil.test"), "suffix trick rejected");
check(!auth.isAllowedEmail("x" + "dwhigham94@gmail.com"), "prefix trick rejected");

// --- Every admin function ---------------------------------------------------
const ADMIN_FNS = fs
  .readdirSync(FN_DIR)
  .filter((f) => /^admin-.*\.js$/.test(f))
  .sort();
const EXPECTED_FNS = [
  "admin-fulfill.js",
  "admin-me.js",
  "admin-orders.js",
  "admin-subscriptions.js",
];
check(
  JSON.stringify(ADMIN_FNS) === JSON.stringify(EXPECTED_FNS),
  `admin functions are ${EXPECTED_FNS.join(", ")} (got ${ADMIN_FNS.join(", ")}); add new ones to this test`
);

const METHOD = {
  "admin-fulfill.js": "POST",
  "admin-me.js": "GET",
  "admin-orders.js": "GET",
  "admin-subscriptions.js": "GET",
};

function event(file, extraHeaders = {}) {
  return {
    httpMethod: METHOD[file],
    headers: { host: "leadreloadhq.com", ...extraHeaders },
    body: METHOD[file] === "POST" ? JSON.stringify({ orderId: ORDER.id, status: "fulfilled" }) : "",
  };
}
const ctx = (user) => ({ clientContext: user === undefined ? {} : { user } });

const NO_USER = [
  ["no context", undefined],
  ["empty context", {}],
  ["no clientContext.user", ctx(undefined)],
  ["null user", ctx(null)],
];
const WRONG_USERS = [
  ["other email", { email: "attacker@example.com", sub: "u1" }],
  ["other email with admin role", { email: "attacker@example.com", app_metadata: { roles: ["admin"] } }],
  ["look-alike email", { email: "dwhigham94@gmail.com.evil.test" }],
  ["near-miss domain", { email: "dwhigham94@gmail.co" }],
  ["no email", { sub: "u2", app_metadata: { roles: ["admin"] } }],
];
const GOOD_USERS = [
  ["Dan", { email: "dwhigham94@gmail.com", sub: "dan" }],
  ["Zac", { email: "zacfischer10x@gmail.com", sub: "zac" }],
  ["Dan mixed case", { email: "DWhigham94@Gmail.COM" }],
  ["Zac mixed case, no role", { email: " ZacFischer10x@gmail.com ", app_metadata: {} }],
];

(async () => {
  for (const file of ADMIN_FNS) {
    const { handler } = require(path.join(FN_DIR, file));

    for (const [label, c] of NO_USER) {
      storeCalls = 0;
      // A leftover cookie from the old password gate must not help.
      const res = await handler(event(file, { cookie: "lr_admin_session=anything.sig" }), c);
      check(res.statusCode === 401, `${file} ${label} → 401 (got ${res.statusCode})`);
      check(JSON.parse(res.body).reason === "unauthorized", `${file} ${label} reason`);
      check(storeCalls === 0, `${file} ${label} must not touch storage`);
      check(/no-store/.test(res.headers["Cache-Control"] || ""), `${file} ${label} no-store`);
    }

    for (const [label, user] of WRONG_USERS) {
      storeCalls = 0;
      const res = await handler(event(file), ctx(user));
      check(res.statusCode === 403, `${file} ${label} → 403 (got ${res.statusCode})`);
      check(JSON.parse(res.body).reason === "forbidden", `${file} ${label} reason`);
      check(storeCalls === 0, `${file} ${label} must not touch storage`);
    }

    for (const [label, user] of GOOD_USERS) {
      const res = await handler(event(file), ctx(user));
      const data = JSON.parse(res.body);
      check(res.statusCode === 200 && data.ok === true, `${file} ${label} → 200 (got ${res.statusCode} ${res.body})`);
      check(/no-store/.test(res.headers["Cache-Control"] || ""), `${file} ${label} no-store`);
      if (file === "admin-me.js") {
        check(EXPECTED.includes(data.email), `${file} ${label} returns normalized email`);
      }
    }

    const pre = await handler({ httpMethod: "OPTIONS", headers: {} }, {});
    check(pre.statusCode === 204, `${file} OPTIONS → 204`);
  }

  // --- Password gate retired ------------------------------------------------
  check(!fs.existsSync(path.join(FN_DIR, "admin-login.js")), "admin-login.js removed");
  check(!fs.existsSync(path.join(FN_DIR, "admin-logout.js")), "admin-logout.js removed");
  for (const name of ["authenticateUser", "createSessionCookie", "getSession", "checkPassword", "adminConfigured"]) {
    check(!(name in auth), `lib/auth.js no longer exports ${name}`);
  }
  const RETIRED = /ADMIN_(DAN_|ZAC_)?PASSWORD|ADMIN_SESSION_SECRET|lr_admin_session|admin-login|admin-logout/;
  const walk = (dir) =>
    fs.readdirSync(dir, { withFileTypes: true }).flatMap((d) => {
      const p = path.join(dir, d.name);
      return d.isDirectory() ? walk(p) : [p];
    });
  for (const file of [...walk(FN_DIR), ...walk(path.join(ROOT, "public"))]) {
    if (!/\.(js|html)$/.test(file)) continue;
    const src = fs.readFileSync(file, "utf8");
    check(!RETIRED.test(src), `${path.relative(ROOT, file)} has no password-gate references`);
    check(!/@setrpro\.io/i.test(src), `${path.relative(ROOT, file)} has no @setrpro.io email`);
  }

  // --- Admin page uses Identity ----------------------------------------------
  const adminHtml = fs.readFileSync(path.join(ROOT, "public/admin/index.html"), "utf8");
  const adminJs = fs.readFileSync(path.join(ROOT, "public/admin/admin.js"), "utf8");
  check(/identity\.netlify\.com\/v1\/netlify-identity-widget\.js/.test(adminHtml), "admin loads Identity widget");
  check(!/type="password"/.test(adminHtml), "admin page has no password field");
  check(/Authorization:\s*"Bearer "/.test(adminJs), "admin.js sends Identity JWT as Bearer");
  check(/api\("admin-me"/.test(adminJs), "admin.js checks access via admin-me");
  const indexHtml = fs.readFileSync(path.join(ROOT, "public/index.html"), "utf8");
  check(/<script src="identity-redirect\.js[^"]*"><\/script>\s*<\/head>/.test(indexHtml), "site root loads identity-redirect.js in <head>");

  // --- Root forwards Identity email links to /admin/ -------------------------
  const redirectSrc = fs.readFileSync(path.join(ROOT, "public/identity-redirect.js"), "utf8");
  function runRedirect(pathname, hash, search = "") {
    const calls = [];
    vm.runInNewContext(redirectSrc, {
      location: { pathname, hash, search, replace: (u) => calls.push(u) },
    });
    return calls;
  }
  for (const key of ["invite_token", "recovery_token", "confirmation_token", "email_change_token"]) {
    const hash = `#${key}=abc123`;
    check(JSON.stringify(runRedirect("/", hash)) === JSON.stringify([`/admin/${hash}`]), `root ${key} → /admin/${hash}`);
    check(JSON.stringify(runRedirect("/index.html", `#/${key}=abc`)) === JSON.stringify([`/admin/#/${key}=abc`]), `index.html #/${key} forwarded`);
    check(runRedirect("/admin/", hash).length === 0, `/admin/ ${key} not redirected (widget handles it)`);
    check(
      JSON.stringify(runRedirect("/", "", `?${key}=q1`)) === JSON.stringify([`/admin/#${key}=q1`]),
      `root ?${key} → /admin/#${key}`
    );
  }
  check(runRedirect("/", "").length === 0, "plain root not redirected");
  check(runRedirect("/", "#pricing").length === 0, "normal anchors not redirected");
  check(runRedirect("/", "", "?utm_source=x").length === 0, "normal query not redirected");

  console.log(`PASS — admin Identity gate: ${passed} assertions (${ADMIN_FNS.length} admin functions)`);
})().catch((err) => {
  console.error("FAIL:", err && err.message ? err.message : err);
  process.exit(1);
});

"use strict";

/**
 * Admin auth for /admin/ and the admin-* functions: Netlify Identity.
 *
 * The browser (Identity widget on /admin/) sends
 *   Authorization: Bearer <Identity JWT>
 * Netlify verifies that JWT before the function runs and puts the decoded
 * user on context.clientContext.user. A missing, forged or expired token
 * means there is no user there.
 *
 *   no Identity user                      -> 401 unauthorized
 *   user whose email is not in the list   -> 403 forbidden
 *   user whose email is in ADMIN_EMAILS   -> allowed
 *
 * The email allowlist is the gate on its own; no Identity role is needed.
 * An app_metadata role such as "admin" does NOT let anyone else in. That
 * keeps admin to exactly these two people even if someone else is ever
 * invited or given a role by mistake. Identity registration is invite-only.
 *
 * To add or remove an admin: edit ADMIN_EMAILS (lowercase), run npm test,
 * merge, and invite/remove the Identity user in the Netlify UI.
 */
const ADMIN_EMAILS = Object.freeze([
  "dwhigham94@gmail.com", // Dan
  "zacfischer10x@gmail.com", // Zac
]);

function normalizeEmail(email) {
  return String(email || "").trim().toLowerCase();
}

function isAllowedEmail(email) {
  const e = normalizeEmail(email);
  return e !== "" && ADMIN_EMAILS.includes(e);
}

function identityUser(context) {
  const user = context && context.clientContext && context.clientContext.user;
  return user && typeof user === "object" ? user : null;
}

/**
 * @returns {{ok:true, user:{email:string, sub:string|null}}
 *          |{ok:false, statusCode:401|403, error:string}}
 */
function requireAdmin(event, context) {
  const user = identityUser(context);
  if (!user) return { ok: false, statusCode: 401, error: "unauthorized" };
  if (!isAllowedEmail(user.email)) {
    return { ok: false, statusCode: 403, error: "forbidden" };
  }
  return {
    ok: true,
    user: { email: normalizeEmail(user.email), sub: user.sub || null },
  };
}

module.exports = {
  ADMIN_EMAILS,
  normalizeEmail,
  isAllowedEmail,
  identityUser,
  requireAdmin,
};

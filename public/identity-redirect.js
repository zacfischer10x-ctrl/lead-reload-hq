/**
 * Netlify Identity email links (invite, password recovery, email confirmation,
 * email change) land on the site root as
 *   https://leadreloadhq.com/#invite_token=...
 * The storefront has no Identity widget, so send the whole hash to /admin/,
 * where the widget shows the set-password / reset-password screen and then
 * the admin. Same approach as dwhigham.com's identity-bootstrap.js.
 * Loaded on every public page, never on /admin/. No other effect.
 */
(function () {
  "use strict";
  var TOKEN_RE =
    /(?:^|[#&?\/])(invite_token|recovery_token|confirmation_token|email_change_token|access_token)=|error=access_denied/;
  var path = location.pathname || "/";
  if (/^\/admin(\/|$)/.test(path)) return;

  var hash = location.hash || "";
  if (TOKEN_RE.test(hash)) {
    location.replace("/admin/" + hash);
    return;
  }
  // Some mail clients / templates put the token in the query string instead.
  var search = (location.search || "").replace(/^\?/, "");
  if (TOKEN_RE.test("?" + search)) {
    location.replace("/admin/#" + search);
  }
})();

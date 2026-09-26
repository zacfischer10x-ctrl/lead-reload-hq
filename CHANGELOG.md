# Changelog — Lead Reload HQ

Newest first. Times are ET (America/New_York). Add a dated entry after every change.

## 2026-09-26

### ~11:35 AM ET — Admin sign-in moved to Netlify Identity; shared password gate removed _(same branch, patch 7/7, pending Zac's merge; approved by Dan)_
- **`/admin/` now signs in with Netlify Identity** (the Identity widget, same pattern as dwhigham.com). Registration is invite-only; each admin sets their own password from the invite email, and "Forgot password?" sends a reset email.
- **Allowlist:** `ADMIN_EMAILS` in `netlify/functions/lib/auth.js` = `dwhigham94@gmail.com` (Dan), `zacfischer10x@gmail.com` (Zac), compared lowercase. The email list is the whole gate: no Identity role needed, and an `admin` role alone does not let anyone else in.
- **Every admin function** (`admin-orders`, `admin-subscriptions`, `admin-fulfill`, new `admin-me`) reads the Identity user from `context.clientContext.user` (Netlify verifies the `Authorization: Bearer` JWT): no user → **401** `unauthorized`, other email → **403** `forbidden`, both before touching storage. Admin responses are `Cache-Control: no-store`, `Vary: Authorization`.
- **Invite / recovery / confirmation links** (`/#invite_token=…`, `#recovery_token=`, `#confirmation_token=`, `#email_change_token=`) that land on the site root are forwarded to `/admin/` by new `public/identity-redirect.js`; the widget on `/admin/` shows the set-password screen, then the admin. A signed-in non-admin sees "No admin access" with a Sign out button.
- **Removed:** `admin-login` and `admin-logout` functions, the username/password form, the `lr_admin_session` cookie, and all reads of `ADMIN_DAN_PASSWORD`, `ADMIN_ZAC_PASSWORD`, `ADMIN_PASSWORD`, `ADMIN_SESSION_SECRET`. Dropped the now-unused `cookie` dependency. Old cookies are ignored (401).
- **Tests:** new `scripts/test-admin-auth.js` in `npm test`: each admin function → 401 with no user (storage untouched), 403 for other/look-alike emails and for a non-allowlisted user with an `admin` role, 200 for both allowed emails (any case); no password-gate references left in `public/` or `netlify/functions/`; root → `/admin/` forwarding for all four token types.
- **Netlify:** Identity must be enabled on `lead-reload-hq` (invite-only, external providers off) before merge. Invites go out only after this is live. After both admins sign in, delete the four retired `ADMIN_*` env vars.

## 2026-09-25

### ~3:55 PM ET — Pricing update: 5 age bands for both lead types, new prices, no-discount wording, portal copy removed _(same branch, patch 6/6, pending Zac's merge)_
- **Age bands:** General Life / Mortgage Protection and Private Health now use the same 5 bands: Under 30, 30–60, 60–90, 90–365, 365+ days. Removed Private Health 90–180 and 180–360; Life "90+ days" (overlapped 365+) is now "90–365 days". Band ids: `lm-u30`, `lm-30-60`, `lm-60-90`, `lm-90-365`, `lm-365` / `ph-u30`, `ph-30-60`, `ph-60-90`, `ph-90-365`, `ph-365`. Retired ids `ph-90-180`, `ph-180-360`, `lm-90` → `create-checkout` 400 `invalid_age_band`; a saved cart holding one is reset to the Age step.
- **Prices per lead** (storefront `public/app.js` and server `lib/pricing.js`, identical):
  - General Life / Mortgage Protection: $0.52 / $0.39 / $0.20 / $0.10 / $0.03
  - Private Health: $0.52 / $0.33 / $0.26 / **$0.13** / $0.03
  - Private Health 90–365 at $0.13 **confirmed by Dan** (2026-09-25); the price table is final. The value lives in one constant, `PRIVATE_HEALTH_90_365`, in both `netlify/functions/lib/pricing.js` and `public/app.js`; `npm test` fails if they differ.
- **No volume discounts:** "Volume buyers welcome" (hero) and "Volume & custom programs welcome" (footer) → "Large orders welcome, up to 100,000 leads per order". Quantity callout now says "same per-lead price at any quantity". No tiers added.
- **Customer portal copy removed:** checkout success message now says "To cancel or change a subscription, reply to your receipt email or contact us." (the site has no contact email/page to link).
- `app.js` cache-bust bumped to `?v=20260925hq`. Tests updated: exact 5-band tables, retired ids rejected, $0.50 minimum (16 × $0.03 blocked, 17 allowed) for both tables, success copy has no portal mention. Docs (`STRIPE_SETUP.md`, `PROJECT_BRIEF.md`, `README.md`) updated.

### ~3:25 PM ET — Security patches: server-side pricing, signed webhooks, portal disabled, checkout probe fix _(branch `security/server-pricing-webhook-portal`, pending Zac's merge)_
- **Server-side pricing (A):** `create-checkout` no longer trusts the browser's `unitPrice` (anyone could buy leads for pennies). New `netlify/functions/lib/pricing.js` holds the price table, seeded with the storefront prices at the time (superseded by the ~3:55 PM price update above). Amount = server unit price × quantity for every cadence. Unknown lead type / age-band combos → 400. `npm test` checks every lead type × age band combo (now 15) × quantities 1–100,000 × 3 cadences match the displayed totals.
- **Webhook (B):** `stripe-webhook` rejects instead of parsing unsigned events: no `STRIPE_WEBHOOK_SECRET` → 503 `webhook_secret_not_configured`; missing/invalid `Stripe-Signature` → 400.
- **Portal (C):** `create-portal` disabled → 403 `portal_disabled` (it returned a billing-portal session to anyone with a customer's email). Not used by any UI. Re-enable only behind admin login or a signed customer session.
- **Storefront checkout gate (D):** fixed the Stripe probe in `public/app.js` — the server's live reply `{ok:true, configured:true}` (no `url`) was treated as "not ready", so Pay stayed on "Payments coming online tonight" even with keys set. `stripe_not_configured` still shows the offline state. Orders under $0.50 now show "Minimum order is $0.50. Add more leads." before calling checkout (and instead of the raw `amount_too_small`). No prices changed.
- Added `scripts/test-pricing.js`, `scripts/test-webhook.js`, `scripts/test-portal.js`, `scripts/test-probe.js` (`npm test`, no new deps). Updated `STRIPE_SETUP.md`.
- No Netlify, Stripe, or deploy changes were made; ships when Zac merges to `main`. **After merge, `STRIPE_WEBHOOK_SECRET` must be set in Netlify or all webhooks get 503.**

### ~2:25 PM ET — Repo set public for Netlify free-plan builds
- Switched `zacfischer10x-ctrl/lead-reload-hq` from private to **public** so Netlify (free plan, 1 seat) can build commits from Zac’s GitHub without adding a team member.
- Secrets remain in Netlify env only; this push re-triggers production deploy for Webby to confirm.


### ~10:40 AM ET — GitHub deploy key + webhook + first auto-deploy test
- Added Netlify deploy key on `zacfischer10x-ctrl/lead-reload-hq` (title **Netlify**, read-only).
- Push webhook to `https://api.netlify.com/hooks/github` already present from 2026-09-24.
- This CHANGELOG entry is the first push-to-`main` test so Netlify can pull via the deploy key and publish production.

## 2026-09-24

### Evening ET — Repo + continuous deployment _(in progress)_
- Prepared source as a git repo (branch `main`); secret-scanned tracked files (no secrets found; `.env` / `node_modules/` / `.netlify/` ignored).
- Added `PROJECT_BRIEF.md` (read first) and this `CHANGELOG.md`; README points to the brief.
- Change of plan: Zac hosts the private repo at `zacfischer10x-ctrl/lead-reload-hq` (Dan doesn't use GitHub). The Netlify team is on the free plan (1 seat), so instead of adding Zac to the team, the site was linked from Dan's Netlify side via a deploy key + GitHub webhook (`main`, publish `public`, functions `netlify/functions`, build `npm install`). One expected failed build was logged at link time because the repo didn't exist yet; the live site was unaffected.
- Removed the `npm run deploy` (`netlify deploy --prod`) script and updated `STRIPE_SETUP.md` so docs no longer point to manual production deploys or the netlify.app address.
- Next: Zac creates the repo, pushes, adds the deploy key + webhook, and confirms a push deploys to production.

### ~4:00 PM ET — SITE_URL switched to custom domain
- Set Netlify env `SITE_URL=https://leadreloadhq.com` and redeployed.

### ~3:40–4:00 PM ET — Custom domain live
- Connected `leadreloadhq.com` via GoDaddy DNS (apex A `75.2.60.5`, `www` CNAME `lead-reload-hq.netlify.app`).
- Let's Encrypt SSL provisioned for apex + www; Force HTTPS enabled.

### Afternoon ET — Admin auth upgrade
- Replaced single shared password with separate invite-only logins for `dan` and `zac` (`ADMIN_DAN_PASSWORD` / `ADMIN_ZAC_PASSWORD`; legacy `ADMIN_PASSWORD` maps to `dan`), signed httpOnly session cookie `lr_admin_session` (`ADMIN_SESSION_SECRET`). Unauthenticated admin API calls return 401.

### Afternoon ET — Thin admin
- Added `/admin/` UI and functions: `admin-orders`, `admin-subscriptions`, `admin-fulfill`, `admin-login`, `admin-logout`.

### Afternoon ET — Stripe scaffolding
- `create-checkout`: dynamic Stripe Checkout Sessions (`price_data`) for one-time (payment mode) and weekly/monthly (recurring) on one cart; order details in metadata.
- `create-portal`: Stripe Customer Portal.
- `stripe-webhook`: stores orders/subscriptions in Netlify Blobs.
- Graceful "Payments coming online tonight" state (`{ok:false, reason:'stripe_not_configured'}`) until Stripe keys are set.

### Afternoon ET — Branding, messaging, quantities
- HQ branding (header HQ badge, title/meta, footer).
- Kept aged opt-ins / spend-on-workflow hero messaging.
- Volume presets 2,500 / 5,000 / 10,000; copy states orders are not capped at 1,000, custom quantities up to 100,000.

### Afternoon ET — New standalone site
- Reused the earlier Lead Reload mockup as the base for a new standalone Netlify site `lead-reload-hq` (id `2d882b33-c92f-4484-acec-f2905d60fd83`). The old mockup site `effortless-nasturtium-30f8ff` was left untouched.

# Changelog — Lead Reload HQ

Newest first. Times are ET (America/New_York). Add a dated entry after every change.

## 2026-09-29

### ~5:00 AM ET — Business Owner Raw Data product _(branch `checkout/bizowner`, one commit on top of `admin/order-fulfillment` 6b665de; deployed to production by manual Netlify CLI deploy, approved by Dan; pending Zac's merge)_
- **New product: Business Owner Raw Data** (`leadType: "business-owner"`): **$0.003 per record** ($30 per 10k; Dan's price set 2026-09-28 ~10:05 PM ET), priced server-side in `lib/pricing.js` (constant `BUSINESS_OWNER_PER_RECORD`, mirrored in `public/app.js`; `npm test` checks they match). No age band: one pseudo band `bo-flat` ("No age band (flat rate)"), and the wizard skips the Age step (Type ↔ Qty) for this product. States and the one-time / weekly / monthly picker are the same. Prices are kept in integer tenths of a cent: `amountCents = ceil(0.3 × qty)`, so the total is **rounded up to the next whole cent** (40,001 → $120.01). Still one inline `price_data` line with integer `unit_amount`. Life / Mortgage Protection / Private Health prices, presets and the 100,000 cap are unchanged. Product name: "Lead Reload HQ — Business Owner Raw Data ($0.003 per record)"; metadata `unitPrice: "0.003"`, `unitPriceCents: "0.3"`. Admin rows say "records" for this product.
- **$100 minimum (Business Owner only):** the raw total (records × $0.003, before rounding) must be at least $100, so the minimum is **33,334 records** (charged $100.01; 33,333 = $99.999 is too low). `create-checkout` returns **400 `below_minimum`** with `minOrderCents: 10000` and `minQuantity: 33334` and creates no session, for one-time, weekly and monthly. On the page, Continue (Qty step) and Pay stay disabled under the minimum and the Qty step shows "Business Owner Raw Data has a $100.00 minimum order: at least 33,334 records."; a saved cart under the minimum reopens on the Qty step; picking Business Owner with a smaller cart sets the quantity to 35,000. The product card shows a "$100 minimum" badge and "$0.003/record ($30 per 10k)"; the review / success summary shows "Unit price $0.003 / record ($30 per 10k)" and "Minimum $100.00 minimum order". The generic Stripe $0.50 minimum ("Minimum order is $0.50: at least N leads at this price.") still applies to the other products.
- **Per-product quantity presets:** Business Owner shows **35,000 ($105) / 50,000 ($150) / 100,000 ($300) / 250,000 ($750)**; the other products keep 50 / 100 / 250 / 500 / 1,000 / 2,500 / 5,000 / 10,000 (two `.qty-presets[data-presets]` groups; the page shows the one for the selected product). The custom quantity field stays (min 33,334 for Business Owner). **Business Owner max: 1,000,000 records per order** on the page and the server (1,000,001 → 400 `invalid_quantity`); other products stay at 100,000. The "up to 100,000 … per-lead" volume callout is hidden for Business Owner, which shows its own note instead.
- **General guard:** Continue on the Qty step is disabled under Stripe's $0.50 minimum for every product (and under the Business Owner $100 minimum); Pay is also disabled while the cart is under a product minimum.
- **Type cards:** the product grid is 2 × 2 on tablet/desktop (4 products). The Age step pill is struck through when Business Owner is selected.
- **Tests:** new `scripts/test-bizowner.js` (presets × cadences, 33,333 rejected / 33,334 accepted, rounding, tampered prices, 1,000,000 cap, per-product presets, storefront gating, copy rules) in `npm test` (8 suites). `test-pricing.js` handles the flat sub-cent band, checks every Business Owner quantity 1..1,000,000 against the $100 minimum on both sides and keeps the other products at 1..100,000.
- Cache-bust: `styles.css` / `app.js` → `?v=20260929bo`, admin assets → `?v=20260929bo`.
- **No env var, Stripe, or Netlify setting changes.** The Terms of Sale and Acceptable Use checkbox / `/terms/` page is **on hold** (saved separately on branch `checkout/terms-acceptance`, not live).

## 2026-09-28

### ~5:20 PM ET — Admin order fulfillment tracking _(branch `admin/order-fulfillment`, pending Zac's merge; requested by Dan)_
- **Order rows:** every paid order is now a fulfillable row in `lr-orders`: `kind` `one-time` (unchanged, key = session id), **new** `subscription` (the first period of a weekly/monthly checkout, key = session id, links `stripeSubscriptionId` + first `stripeInvoiceId`), and **new** `renewal` (each later `invoice.paid`, key = invoice id, with amount paid, billing period, payment intent, and lead type / age band / quantity / states copied from the subscription metadata).
- **No double count:** `invoice.paid` with `billing_reason: subscription_create` gets no row (the checkout's subscription row already covers that period). Other paid subscription invoices (`subscription_cycle`, and rarer `manual` / `subscription_update` / threshold ones) each get a renewal row; `billingReason` is stored.
- **Idempotent:** rows are keyed by session id / invoice id, and a Stripe retry refreshes the Stripe fields but keeps the admin's fulfillment status and `createdAt`. This also fixes an older bug where a retried `checkout.session.completed` reset a fulfilled order to open. Signature verification and the subscription-record writes are unchanged. Invoices in both payload shapes (API ≤ 2025-02 `invoice.subscription`, 2025-03+ `invoice.parent.subscription_details`) are read.
- **Fulfillment fields:** `fulfillmentStatus` (`New` | `In progress` | `Completed`, default New), `completedAt`, `completedBy` (admin Identity email), `statusUpdatedAt`, `statusUpdatedBy`. Older rows read as New (legacy `status: "fulfilled"` reads as Completed with `completedAt = fulfilledAt`); nothing is migrated. The legacy `status` / `fulfilledAt` fields stay in sync.
- **Admin API:** `admin-orders` takes `?status=all|open|completed&type=all|one-time|subscription` (open = New or In progress; subscription = initial + renewals), returns `counts`, and 400s on bad filters. `admin-fulfill` takes `{orderId, action: complete|start|reopen}` or `{orderId, status}`; Completed stamps `completedAt`/`completedBy`, moving back clears them, and input is validated (400 `missing_order_id` / `invalid_order_id` / `invalid_action` / `invalid_status`, 404 `not_found`). The legacy `open` / `fulfilled` values are still accepted. Both are still 401 without login and 403 for other emails, before touching storage.
- **Admin UI:** the Orders tab shows date, email, lead type / age band, quantity, states, amount, cadence/type (One-time, Weekly/Monthly subscription, Weekly/Monthly renewal), session id and payment intent / invoice id, and a status badge. It adds a one-tap **Mark completed** button, In progress / Back to New / Reopen, a status picker in Detail, filter pills (Open / Completed / All with counts, All types / One-time / Subscription), and **Export CSV** of the filtered rows (all columns plus completedAt/By; RFC 4180 quoting; cells starting with `=` `+` `-` `@` (or tab/CR) get a leading `'`). Layout is mobile-first. New `public/admin/orders-view.js`. Cache-bust `admin.css` / `admin.js` / `orders-view.js` → `?v=20260928ful`.
- **Tests:** new `scripts/test-renewals.js` (renewal rows, first-invoice dedupe, retry idempotency incl. after completion, legacy rows, both invoice shapes, subscription filter) and `scripts/test-fulfillment.js` (status model, transitions + completedBy, filters, validation, 401/403, CSV escaping, UI wiring) in `npm test` (7 suites).
- **No env var, Stripe, or Netlify changes.** No new webhook events: `invoice.paid` is already on the endpoint list. Subscriptions bought before this ships have no initial order row (only renewals from now on).

### ~6:40 AM ET — Neutral lead wording (non-exclusive) + offline-banner fix _(branch `copy/non-exclusive-neutral`, pending Zac's merge; decided by Dan)_
- **Copy:** Lead Reload HQ leads are **not exclusive**, and public copy makes no exclusivity, opt-in, consent, or similar claims. `index.html` title / og:title "Order Exclusive Leads" → "Order Aged Insurance Leads"; meta description → "aged insurance lead data. Order by lead type, age band, quantity, and state."; og:description → "Aged insurance lead data. Buy the data, spend on the workflow."; hero H1 → "Order aged insurance leads"; value callout title → "Aged leads need follow-up" (body's last sentence → "That's where the work on aged leads happens."); footer tagline → "Aged insurance lead marketplace". Also `package.json` description, `README.md`, and `PROJECT_BRIEF.md` (locked decision 2 updated). No price, functionality, or `app.js` change.
- **Fix:** `.pay-offline-banner[hidden] { display: none }` — the banner's `display: grid` overrode the `hidden` attribute, so "Payments coming online tonight" showed even when Stripe was live. `styles.css` cache-bust → `?v=20260928copy`.
- **New `scripts/live-copy-check.sh`:** curls the live site (`/`, `/app.js`, CSS/JS, `/admin/`, legal paths) and greps for the ruled-out wording. Run after the deploy: `bash scripts/live-copy-check.sh` (exit 0 = clean).

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

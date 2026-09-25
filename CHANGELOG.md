# Changelog — Lead Reload HQ

Newest first. Times are ET (America/New_York). Add a dated entry after every change.

## 2026-09-25

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

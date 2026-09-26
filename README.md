# Lead Reload HQ

> **Read [`PROJECT_BRIEF.md`](PROJECT_BRIEF.md) first** — site facts, locked decisions, env var names, open items, and working rules. Log every change in [`CHANGELOG.md`](CHANGELOG.md).

Premium B2B storefront for aged opt-in insurance leads. Evolved from the Lead Reload mockup (UI, pricing, wizard, logo reused — not redesigned from scratch).

**Work only under** `/workspace/lead-reload-hq/`. Source mockup at `/workspace/setr-marketing-data/` is not modified in place. Existing Netlify mockup `effortless-nasturtium-30f8ff` is left alone.

## Layout

```
public/                 storefront + /admin/
netlify/functions/      Stripe + admin APIs
netlify.toml
package.json
PROJECT_BRIEF.md        read first — project facts + rules
CHANGELOG.md            dated change log
STRIPE_SETUP.md         env vars + webhook URL pattern
DEPLOY_INFO.md          initial deploy snapshot + DNS steps (historical)
```

## Local

```bash
cd /workspace/lead-reload-hq
npm install
netlify dev
```

Without `STRIPE_SECRET_KEY`, Pay shows **Payments coming online tonight**.

## Branding & qty

- **Lead Reload HQ** in header (logo + HQ badge), `<title>`, footer, meta
- Presets keep gold volume chips **2,500 / 5,000 / 10,000**
- Callout: buyers are **not capped at 1,000**; custom qty up to **100,000**; same per-lead price at any quantity (no volume discounts)
- Age bands (both lead types): Under 30, 30–60, 60–90, 90–365, 365+ days — prices in `STRIPE_SETUP.md`
- Hero keeps aged opt-ins / spend-on-workflow messaging
- Billing: one-time / weekly / monthly (`billingCadence`)

## Admin

`/admin/` signs in with **Netlify Identity** (invite-only, no public signup). Only the emails in `ADMIN_EMAILS` (`netlify/functions/lib/auth.js`) get in: `dwhigham94@gmail.com` (Dan) and `zacfischer10x@gmail.com` (Zac). Admin functions return 401 without a signed-in Identity user and 403 for any other email. Invite links that land on `/` are forwarded to `/admin/` by `public/identity-redirect.js`. Details: `PROJECT_BRIEF.md` → Admin access summary.

`npm test` runs every suite, including `scripts/test-admin-auth.js` (401 / 403 / allowed for each admin function).

## Deploy

Deploy only by pushing to `main` of the private repo `zacfischer10x-ctrl/lead-reload-hq` (Netlify continuous deployment). Manual `netlify deploy --prod` is retired.

Stripe keys: see `STRIPE_SETUP.md`. DNS for leadreloadhq.com: see `DEPLOY_INFO.md`.

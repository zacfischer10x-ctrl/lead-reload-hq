# Lead Reload HQ — Project Brief

> **Read this first.** Anyone (human or agent) changing this repo must read this brief before touching anything, and follow the [Working rules](#working-rules) at the bottom.

_Last updated: 2026-09-24 (ET)_

---

## 1. What this is

**Lead Reload HQ** is a lead-ordering storefront for premium aged opt-in insurance leads. Buyers build an order (lead type, age band, quantity, states, billing cadence) and pay through Stripe's hosted checkout.

| | |
|---|---|
| Production domain | **https://leadreloadhq.com** (primary; `www.leadreloadhq.com` is an alias) |
| Fallback URL | https://lead-reload-hq.netlify.app |
| Admin | **/admin/** — invite-only, usernames **`dan`** and **`zac`** (case-insensitive), no public signup |
| Owners | Co-owned by **Dan Whigham** and **Zac Fischer** |

### Admin access summary

- Passwords come only from Netlify env vars `ADMIN_DAN_PASSWORD` / `ADMIN_ZAC_PASSWORD` (legacy `ADMIN_PASSWORD` still logs in as `dan`).
- Session is a signed, httpOnly cookie **`lr_admin_session`** (signed with `ADMIN_SESSION_SECRET`).
- Unauthenticated calls to admin APIs return **401**.

---

## 2. Hosting

| Setting | Value |
|---|---|
| Host | Netlify |
| Site name | `lead-reload-hq` |
| Site ID | `2d882b33-c92f-4484-acec-f2905d60fd83` |
| Team | Invictus Marketing Group (slug `dwhigham94`) |
| Publish dir | `public/` |
| Functions dir | `netlify/functions/` |
| Build command | `npm install` |
| Config | `netlify.toml` |

### Deploys

- **Continuous deployment from the GitHub `main` branch.** Status as of 2026-09-24: **being connected** (repo prepared locally; GitHub link + Netlify CD not yet live).
- Once CD is live, **manual `netlify deploy --prod` is retired.** Deploy by pushing/merging to `main`.

### DNS (GoDaddy)

| Type | Host | Value |
|---|---|---|
| A | `@` (apex) | `75.2.60.5` |
| CNAME | `www` | `lead-reload-hq.netlify.app` |

Do not add AAAA records on `@` (breaks Netlify SSL).

### SSL

- Let's Encrypt certificate (via Netlify) covering `leadreloadhq.com` + `www.leadreloadhq.com`; expires **2026-12-23** (Netlify auto-renews).
- **Force HTTPS** is on.

---

## 3. Repo layout

```
public/                     Static storefront (publish dir)
  index.html, app.js,       Order wizard, cart, pricing, Stripe checkout call
  styles.css, lead-reload-logo.png
  admin/                    Thin invite-only admin UI (index.html, admin.js, admin.css)
netlify/functions/          Serverless functions
  create-checkout.js        Builds a dynamic Stripe Checkout Session with price_data.
                            one-time → payment mode; weekly/monthly → subscription (recurring).
                            Order details go in metadata. With no Stripe key it returns
                            {ok:false, reason:'stripe_not_configured'} and the Pay button shows
                            "Payments coming online tonight".
  stripe-webhook.js         Verifies Stripe signature; stores orders/subscriptions in Netlify Blobs.
  create-portal.js          Creates a Stripe Customer Portal session.
  admin-login.js            Username + password login → sets lr_admin_session cookie.
  admin-logout.js           Clears the session cookie.
  admin-orders.js           Lists orders (admin only).
  admin-subscriptions.js    Lists subscriptions (admin only).
  admin-fulfill.js          Marks an order fulfilled (admin only).
  lib/                      Shared helpers: auth.js (sessions/allowlist), blobs.js,
                            http.js (JSON/CORS/SITE_URL), stripe-client.js
netlify.toml                Build settings, /api/* → functions redirect, /admin redirect, security headers
package.json                Deps: stripe, @netlify/blobs, cookie
.env.example                Placeholder env var names only (real values live in Netlify)
PROJECT_BRIEF.md            This file
CHANGELOG.md                Dated change log (newest first)
README.md                   Quick start; points here
STRIPE_SETUP.md             Stripe env vars, webhook URL + events
DEPLOY_INFO.md              Snapshot of initial deploy + DNS instructions (historical)
```

---

## 4. Locked decisions

Do not change these without asking Dan/Zac first.

1. **HQ branding** — "Lead Reload HQ" in the header (logo + **HQ badge**), page `<title>`/meta, and footer.
2. **Hero messaging** — aged opt-ins / spend-on-workflow positioning stays.
3. **Quantity presets** — **2,500 / 5,000 / 10,000** volume chips.
4. **Orders are NOT capped at 1,000** — custom quantities up to **100,000**; larger/custom programs welcome.
5. **Billing** — **one-time + weekly + monthly** on one cart.
6. **Payments architecture** — **dynamic Stripe Checkout Sessions** + **Stripe Customer Portal** + **webhooks** into a thin admin. **Not** Stripe Payment Links.

---

## 5. Environment variables (names only)

Values live **only in Netlify env vars** for site `lead-reload-hq` — never in this repo. Redeploy after changing any value.

| Name | Required | Purpose |
|---|---|---|
| `STRIPE_SECRET_KEY` | Yes (for payments) | Server-side Stripe SDK |
| `STRIPE_WEBHOOK_SECRET` | Yes (for webhook) | Verifies Stripe webhook signatures |
| `STRIPE_PUBLISHABLE_KEY` | Optional | Reserved (Checkout is hosted) |
| `SITE_URL` | Recommended | Base for success/cancel + portal return URLs |
| `ADMIN_DAN_PASSWORD` | Yes (admin) | Login for `dan` |
| `ADMIN_ZAC_PASSWORD` | Yes (admin) | Login for `zac` |
| `ADMIN_PASSWORD` | Legacy / optional | Shared fallback; logs in as `dan` |
| `ADMIN_SESSION_SECRET` | Yes | Signs the `lr_admin_session` cookie |

---

## 6. Open items

- [ ] **(a)** Dan adds `STRIPE_SECRET_KEY` and `STRIPE_WEBHOOK_SECRET` in Netlify env, then redeploy.
- [ ] **(b)** Register the Stripe webhook endpoint `https://leadreloadhq.com/.netlify/functions/stripe-webhook` for events:
  - `checkout.session.completed`
  - `customer.subscription.created`
  - `customer.subscription.updated`
  - `customer.subscription.deleted`
  - `invoice.paid`
- [x] **(c)** `SITE_URL = https://leadreloadhq.com` — **DONE 2026-09-24**.
- [ ] Connect GitHub repo + Netlify continuous deployment from `main` (in progress 2026-09-24).

---

## Working rules

1. **Read this brief** before changing anything.
2. **Add a dated entry to `CHANGELOG.md`** after every change.
3. **Secrets only in Netlify env vars** — never commit keys, passwords, tokens, or `.env` files.
4. **Ask Dan/Zac first** before any change to **payments, pricing, or admin access**.
5. **Deploy by pushing to `main`** — no manual production deploys once CD is live.

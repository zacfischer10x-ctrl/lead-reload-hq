# Lead Reload HQ — Project Brief

> **Read this first.** Anyone (human or agent) changing this repo must read this brief before touching anything, and follow the [Working rules](#working-rules) at the bottom.

_Last updated: 2026-09-26 (ET)_

---

## 1. What this is

**Lead Reload HQ** is a lead-ordering storefront for premium aged opt-in insurance leads. Buyers build an order (lead type, age band, quantity, states, billing cadence) and pay through Stripe's hosted checkout.

| | |
|---|---|
| Production domain | **https://leadreloadhq.com** (primary; `www.leadreloadhq.com` is an alias) |
| Fallback URL | https://lead-reload-hq.netlify.app |
| Admin | **/admin/** — Netlify Identity sign-in, invite-only, allowlisted emails **`dwhigham94@gmail.com`** (Dan) and **`zacfischer10x@gmail.com`** (Zac), no public signup |
| Owners | Co-owned by **Dan Whigham** and **Zac Fischer** |

### Admin access summary

- Sign-in is **Netlify Identity** (the Identity widget on `/admin/`). Identity registration is **invite-only**; external providers (Google, GitHub, etc.) are off. Each person sets their own password from the invite email; "Forgot password?" in the widget sends a reset email.
- Every admin function checks the Identity user Netlify puts on `context.clientContext.user` (from the `Authorization: Bearer <JWT>` the admin page sends) in `netlify/functions/lib/auth.js`:
  - no user → **401** `unauthorized`; user whose email is not in **`ADMIN_EMAILS`** → **403** `forbidden`.
  - `ADMIN_EMAILS` (one constant, compared lowercase) = `dwhigham94@gmail.com`, `zacfischer10x@gmail.com`. The email list is the whole gate; no Identity role is needed, and a role alone does not grant access.
- Invite/recovery/confirmation email links land on the site root (`/#invite_token=…`); `public/identity-redirect.js` forwards them to `/admin/`, where the widget shows the set-password screen and then the admin.
- To change who has admin: edit `ADMIN_EMAILS`, run `npm test`, merge, then invite/remove the user under Netlify → Identity. Both steps are needed.
- The old username/password gate (`ADMIN_DAN_PASSWORD`, `ADMIN_ZAC_PASSWORD`, `ADMIN_PASSWORD`, `ADMIN_SESSION_SECRET`, cookie `lr_admin_session`) was removed on 2026-09-26. The code no longer reads those env vars; delete them from Netlify once the Identity admin is verified live.

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

- **Deploys happen only from pushes to the `main` branch of the private GitHub repo `zacfischer10x-ctrl/lead-reload-hq`** (hosted by Zac Fischer). Manual `netlify deploy --prod` is retired.
- How the link works (set 2026-09-24): the Netlify site is pointed at that repo/branch using a Netlify **deploy key** (read-only SSH key added to the repo's Deploy keys) plus a GitHub **webhook** (`https://api.netlify.com/hooks/github`, JSON, push events). No Netlify GitHub App or team seat is needed. If the repo is renamed or moved, update the site's repo settings in Netlify to match.
- Status as of 2026-09-24 evening: Netlify side configured; waiting for Zac to create the repo, push, and add the deploy key + webhook. Until the first repo-triggered deploy succeeds, the live site stays on the last manual deploy.
- Environment variables stay in Netlify (site `lead-reload-hq`) and are not affected by the repo link.

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
  admin/                    Thin invite-only admin UI (index.html, admin.js, admin.css);
                            signs in with the Netlify Identity widget
  identity-redirect.js      Forwards Identity email links (#invite_token= etc.) from / to /admin/
netlify/functions/          Serverless functions
  create-checkout.js        Builds a dynamic Stripe Checkout Session with price_data, priced
                            server-side from lib/pricing.js (client unitPrice is ignored).
                            one-time → payment mode; weekly/monthly → subscription (recurring).
                            Order details go in metadata. With no Stripe key it returns
                            {ok:false, reason:'stripe_not_configured'} and the Pay button shows
                            "Payments coming online tonight".
  stripe-webhook.js         Verifies Stripe signature (required; no secret → 503, bad/missing
                            signature → 400); stores orders/subscriptions in Netlify Blobs.
  create-portal.js          DISABLED 2026-09-25 (403 portal_disabled) until it sits behind
                            admin login or a signed customer session.
  admin-me.js               Who am I: 200 {email} for an allowlisted Identity user, else 401/403.
  admin-orders.js           Lists orders (admin only).
  admin-subscriptions.js    Lists subscriptions (admin only).
  admin-fulfill.js          Marks an order fulfilled (admin only).
  lib/                      Shared helpers: auth.js (Identity user + ADMIN_EMAILS), blobs.js,
                            http.js (JSON/CORS/SITE_URL), stripe-client.js,
                            pricing.js (server-side price table — must match public/app.js)
scripts/                    test-pricing.js, test-webhook.js, test-portal.js, test-probe.js,
                            test-admin-auth.js (`npm test`, no deps)
netlify.toml                Build settings, /api/* → functions redirect, /admin redirect, security headers
package.json                Deps: stripe, @netlify/blobs
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
4. **Orders are NOT capped at 1,000** — custom quantities up to **100,000**. Copy says "Large orders welcome, up to 100,000 leads per order"; there are **no volume discounts or tiers**, so don't imply any.
5. **Billing** — **one-time + weekly + monthly** on one cart.
6. **Payments architecture** — **dynamic Stripe Checkout Sessions** + **Stripe Customer Portal** (currently **disabled** for security; customers reply to their receipt email or contact us to cancel/change) + **webhooks** into a thin admin. **Not** Stripe Payment Links.
7. **Pricing** — flat unit price per lead type × age band × quantity (2026-09-25). Both lead types use 5 age bands: Under 30, 30–60, 60–90, 90–365, 365+ days.
   - General Life / Mortgage Protection: $0.52 / $0.39 / $0.20 / $0.10 / $0.03
   - Private Health: $0.52 / $0.33 / $0.26 / $0.13 / $0.03 (90–365 at $0.13 confirmed by Dan 2026-09-25; constant `PRIVATE_HEALTH_90_365` in `lib/pricing.js` and `public/app.js` — keep both in sync)
   - $0.50 minimum order (Stripe). Server table `netlify/functions/lib/pricing.js` is what Stripe charges; `public/app.js` must match (`npm test`).

---

## 5. Environment variables (names only)

Values live **only in Netlify env vars** for site `lead-reload-hq` — never in this repo. Redeploy after changing any value.

| Name | Required | Purpose |
|---|---|---|
| `STRIPE_SECRET_KEY` | Yes (for payments) | Server-side Stripe SDK |
| `STRIPE_WEBHOOK_SECRET` | Yes (for webhook) | Verifies Stripe webhook signatures |
| `STRIPE_PUBLISHABLE_KEY` | Optional | Reserved (Checkout is hosted) |
| `SITE_URL` | Recommended | Base for success/cancel + portal return URLs |
| ~~`ADMIN_DAN_PASSWORD`~~, ~~`ADMIN_ZAC_PASSWORD`~~, ~~`ADMIN_PASSWORD`~~, ~~`ADMIN_SESSION_SECRET`~~ | **Retired 2026-09-26** | No longer read. Admin uses Netlify Identity (no env vars). Delete them from Netlify after the Identity admin is verified live. |

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
- [ ] **(d)** Admin → Netlify Identity (2026-09-26): after this code is live on `main`, invite `dwhigham94@gmail.com` and `zacfischer10x@gmail.com` (Netlify → Identity → Invite users), each accepts and sets a password, both sign in at `/admin/`, then delete the retired `ADMIN_*` env vars.
- [ ] Zac creates private repo `zacfischer10x-ctrl/lead-reload-hq`, pushes this code, adds the Netlify deploy key + webhook, then confirms a push to `main` produces a successful production deploy (Netlify side already linked 2026-09-24).

---

## Working rules

1. **Read this brief** before changing anything.
2. **Add a dated entry to `CHANGELOG.md`** after every change.
3. **Secrets only in Netlify env vars** — never commit keys, passwords, tokens, or `.env` files.
4. **Ask Dan/Zac first** before any change to **payments, pricing, or admin access**.
5. **Deploy only by pushing to `main`** of `zacfischer10x-ctrl/lead-reload-hq` — no manual production deploys.

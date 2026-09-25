# Stripe setup — Lead Reload HQ

Paste keys in **Netlify → Site configuration → Environment variables** for site `lead-reload-hq` only.  
Never commit real keys. Redeploy after changing secrets so functions reload them.

## Exact env vars

| Variable | Example shape | Required | Purpose |
|----------|---------------|----------|---------|
| `STRIPE_SECRET_KEY` | `sk_test_…` / `sk_live_…` | Yes for pay | Server Stripe SDK (`create-checkout`, webhook) |
| `STRIPE_WEBHOOK_SECRET` | `whsec_…` | **Yes — webhook refuses all events without it** | Signature check on `stripe-webhook` (missing → `503 webhook_secret_not_configured`) |
| `STRIPE_PUBLISHABLE_KEY` | `pk_test_…` / `pk_live_…` | Optional | Reserved; Checkout is hosted |
| `ADMIN_DAN_PASSWORD` | long random string | Yes for `/admin/` | Invite-only login for username `dan` |
| `ADMIN_ZAC_PASSWORD` | long random string | Yes for `/admin/` | Invite-only login for username `zac` |
| `ADMIN_PASSWORD` | long random string | Optional legacy | Shared password that still logs in as `dan` |
| `ADMIN_SESSION_SECRET` | long random hex | Recommended | Signs `lr_admin_session` cookie |
| `SITE_URL` | `https://leadreloadhq.com` | Recommended | Success/cancel URL base (and portal return base if the portal is re-enabled) |

### CLI (from `/workspace/lead-reload-hq`)

```bash
netlify env:set STRIPE_SECRET_KEY "sk_…"
netlify env:set STRIPE_WEBHOOK_SECRET "whsec_…"
netlify env:set STRIPE_PUBLISHABLE_KEY "pk_…"
netlify env:set ADMIN_DAN_PASSWORD "…"
netlify env:set ADMIN_ZAC_PASSWORD "…"
# then trigger a redeploy (Netlify UI "Trigger deploy" or push to main) so functions reload env vars.
# Do not run `netlify deploy --prod`; deploys come from the GitHub repo.
```

## Admin access (invite-only)

- Allowlisted usernames: **`dan`**, **`zac`** (case-insensitive)
- No public signup
- Session cookie stores the logged-in username; admin UI shows “Signed in as …”

## Webhook URL pattern

```
https://leadreloadhq.com/.netlify/functions/stripe-webhook
```

Also reachable via `/api/stripe-webhook` (redirect in `netlify.toml`).

### Signature verification (required)

`stripe-webhook` only processes events whose `Stripe-Signature` header verifies against `STRIPE_WEBHOOK_SECRET`. There is no unsigned fallback.

| Situation | Response | Stored? |
|-----------|----------|---------|
| `STRIPE_WEBHOOK_SECRET` not set | `503 webhook_secret_not_configured` | No |
| `STRIPE_SECRET_KEY` not set | `503 stripe_not_configured` | No |
| `Stripe-Signature` header missing | `400 missing_signature` | No |
| Signature invalid / wrong secret / body altered | `400 invalid_signature` | No |
| Valid signature | `200 ok` | Yes |

Use the signing secret (`whsec_…`) of **this** endpoint from Stripe Dashboard → Developers → Webhooks → endpoint → "Signing secret" (test and live mode have different secrets). Stripe retries 503/400 deliveries for up to 3 days, so events sent before the secret was set are replayed once it is.

### Events

- `checkout.session.completed`
- `customer.subscription.created`
- `customer.subscription.updated`
- `customer.subscription.deleted`
- `invoice.paid`

## Functions

| Function | Role |
|----------|------|
| `create-checkout` | Checkout Session from cart, **priced server-side** (see below). Missing key → `{ ok:false, reason:"stripe_not_configured" }`. |
| `stripe-webhook` | Verify signature (required, see above); upsert orders/subs in Netlify Blobs |
| `create-portal` | **Disabled** — always `403 { ok:false, reason:"portal_disabled" }`. See below. |
| `admin-login` / `admin-logout` | Username+password cookie session for `/admin/` |
| `admin-orders` / `admin-subscriptions` / `admin-fulfill` | List + mark fulfilled |

## Server-side pricing (`create-checkout`)

Stripe is charged from the price table in `netlify/functions/lib/pricing.js`, never from the browser.

- Inputs that affect price: `leadType`, `ageBandId`, `quantity` (integer 1–100,000), `billingCadence` (`one-time` / `weekly` / `monthly`, same amount per bill).
- `total = unit price (lead type × age band) × quantity`. No tiers, volume discounts, or state/contact surcharges.
- The `unitPrice`, `leadTypeLabel`, `ageBandLabel` fields the storefront sends are **ignored**. Product name and metadata (`unitPrice`, `unitPriceCents`, `amountCents`, labels, `pricing: "server"`) come from the server table.
- 400 reasons: `invalid_cart`, `invalid_quantity`, `invalid_cadence`, `invalid_states`, `invalid_lead_type`, `invalid_age_band` (e.g. `private-health` + `lm-90`), `amount_too_small` (< $0.50 Stripe minimum; the storefront blocks these first with "Minimum order is $0.50. Add more leads.").
- **Changing a price:** edit both `netlify/functions/lib/pricing.js` (cents) and `PRICING` in `public/app.js` (display), then run `npm test` — it fails if the storefront and server disagree for any combo/quantity.

## Customer Portal (disabled)

`create-portal` used to hand a billing-portal session to anyone who knew a customer's email. It now always returns `403 portal_disabled` and nothing in the UI calls it. Until it is rebuilt, subscription changes/cancellations are handled by Dan/Zac in the Stripe Dashboard. Re-enable only behind the admin login (`lib/auth.js` `requireAdmin`) or a signed, short-lived customer token / magic link — see the comment at the top of `create-portal.js`.

### Storefront without Stripe

Pay step shows **Payments coming online tonight** and disables checkout — no crash.

## Test card (test mode)

- `4242 4242 4242 4242` · any future expiry · any CVC · any ZIP

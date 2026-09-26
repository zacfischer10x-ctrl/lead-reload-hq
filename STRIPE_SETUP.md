# Stripe setup — Lead Reload HQ

Paste keys in **Netlify → Site configuration → Environment variables** for site `lead-reload-hq` only.  
Never commit real keys. Redeploy after changing secrets so functions reload them.

## Exact env vars

| Variable | Example shape | Required | Purpose |
|----------|---------------|----------|---------|
| `STRIPE_SECRET_KEY` | `sk_test_…` / `sk_live_…` | Yes for pay | Server Stripe SDK (`create-checkout`, webhook) |
| `STRIPE_WEBHOOK_SECRET` | `whsec_…` | **Yes — webhook refuses all events without it** | Signature check on `stripe-webhook` (missing → `503 webhook_secret_not_configured`) |
| `STRIPE_PUBLISHABLE_KEY` | `pk_test_…` / `pk_live_…` | Optional | Reserved; Checkout is hosted |
| `SITE_URL` | `https://leadreloadhq.com` | Recommended | Success/cancel URL base (and portal return base if the portal is re-enabled) |

### CLI (from `/workspace/lead-reload-hq`)

```bash
netlify env:set STRIPE_SECRET_KEY "sk_…"
netlify env:set STRIPE_WEBHOOK_SECRET "whsec_…"
netlify env:set STRIPE_PUBLISHABLE_KEY "pk_…"
# then trigger a redeploy (Netlify UI "Trigger deploy" or push to main) so functions reload env vars.
# Do not run `netlify deploy --prod`; deploys come from the GitHub repo.
```

## Admin access (invite-only)

- `/admin/` uses **Netlify Identity** (invite-only registration, no external providers). No admin env vars.
- Allowlisted emails, in `ADMIN_EMAILS` in `netlify/functions/lib/auth.js`: **`dwhigham94@gmail.com`**, **`zacfischer10x@gmail.com`** (case-insensitive)
- Admin functions: no Identity user → 401, other email → 403
- The old `ADMIN_DAN_PASSWORD` / `ADMIN_ZAC_PASSWORD` / `ADMIN_PASSWORD` / `ADMIN_SESSION_SECRET` env vars are no longer used (retired 2026-09-26)

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
| `admin-me` | Returns the signed-in admin's email (401 / 403 otherwise) |
| `admin-orders` / `admin-subscriptions` / `admin-fulfill` | List + mark fulfilled (Netlify Identity admin only) |

## Server-side pricing (`create-checkout`)

Stripe is charged from the price table in `netlify/functions/lib/pricing.js`, never from the browser.

- Inputs that affect price: `leadType`, `ageBandId`, `quantity` (integer 1–100,000), `billingCadence` (`one-time` / `weekly` / `monthly`, same amount per bill).
- `total = unit price (lead type × age band) × quantity`. No tiers, volume discounts, or state/contact surcharges.
- The `unitPrice`, `leadTypeLabel`, `ageBandLabel` fields the storefront sends are **ignored**. Product name and metadata (`unitPrice`, `unitPriceCents`, `amountCents`, labels, `pricing: "server"`) come from the server table.
- 400 reasons: `invalid_cart`, `invalid_quantity`, `invalid_cadence`, `invalid_states`, `invalid_lead_type`, `invalid_age_band` (e.g. `private-health` + `lm-u30`, or a retired band id `ph-90-180` / `ph-180-360` / `lm-90`), `amount_too_small` (< $0.50 Stripe minimum; the storefront blocks these first with "Minimum order is $0.50. Add more leads.").
- **Changing a price:** edit both `netlify/functions/lib/pricing.js` (cents) and `PRICING` in `public/app.js` (display), then run `npm test` — it fails if the storefront and server disagree for any combo/quantity.

### Price table (per lead, set 2026-09-25)

Same 5 age bands for every lead type. No quantity tiers or volume discounts.

| Age band | General Life / Mortgage Protection | Private Health |
|---|---|---|
| Under 30 days | $0.52 (`lm-u30`) | $0.52 (`ph-u30`) |
| 30–60 days | $0.39 (`lm-30-60`) | $0.33 (`ph-30-60`) |
| 60–90 days | $0.20 (`lm-60-90`) | $0.26 (`ph-60-90`) |
| 90–365 days | $0.10 (`lm-90-365`) | $0.13 (`ph-90-365`) |
| 365+ days | $0.03 (`lm-365`) | $0.03 (`ph-365`) |

**Private Health 90–365 ($0.13, confirmed by Dan 2026-09-25)** is one constant on each side, `PRIVATE_HEALTH_90_365`. If the price ever changes, edit these two lines to the same value (whole cents) and run `npm test`:

- `netlify/functions/lib/pricing.js`: `const PRIVATE_HEALTH_90_365 = 0.13;`
- `public/app.js`: `  const PRIVATE_HEALTH_90_365 = 0.13;`

## Customer Portal (disabled)

`create-portal` used to hand a billing-portal session to anyone who knew a customer's email. It now always returns `403 portal_disabled` and nothing in the UI calls it. Until it is rebuilt, subscription changes/cancellations are handled by Dan/Zac in the Stripe Dashboard: the storefront success message tells customers "To cancel or change a subscription, reply to your receipt email or contact us." For that to work, Stripe receipt emails should be on (Settings → Customer emails → Successful payments) and the Stripe public support email / reply-to should be an inbox Dan or Zac reads. Re-enable only behind the admin login (`lib/auth.js` `requireAdmin`) or a signed, short-lived customer token / magic link — see the comment at the top of `create-portal.js`.

### Storefront without Stripe

Pay step shows **Payments coming online tonight** and disables checkout — no crash.

## Test card (test mode)

- `4242 4242 4242 4242` · any future expiry · any CVC · any ZIP

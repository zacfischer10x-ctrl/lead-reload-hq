# Stripe setup — Lead Reload HQ

Paste keys in **Netlify → Site configuration → Environment variables** for site `lead-reload-hq` only.  
Never commit real keys. Redeploy after changing secrets so functions reload them.

## Exact env vars

| Variable | Example shape | Required | Purpose |
|----------|---------------|----------|---------|
| `STRIPE_SECRET_KEY` | `sk_test_…` / `sk_live_…` | Yes for pay | Server Stripe SDK (`create-checkout`, webhook, portal) |
| `STRIPE_WEBHOOK_SECRET` | `whsec_…` | Yes for verify | Signature check on `stripe-webhook` |
| `STRIPE_PUBLISHABLE_KEY` | `pk_test_…` / `pk_live_…` | Optional | Reserved; Checkout is hosted |
| `ADMIN_DAN_PASSWORD` | long random string | Yes for `/admin/` | Invite-only login for username `dan` |
| `ADMIN_ZAC_PASSWORD` | long random string | Yes for `/admin/` | Invite-only login for username `zac` |
| `ADMIN_PASSWORD` | long random string | Optional legacy | Shared password that still logs in as `dan` |
| `ADMIN_SESSION_SECRET` | long random hex | Recommended | Signs `lr_admin_session` cookie |
| `SITE_URL` | `https://leadreloadhq.com` | Recommended | Success/cancel + portal return base |

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

### Events

- `checkout.session.completed`
- `customer.subscription.created`
- `customer.subscription.updated`
- `customer.subscription.deleted`
- `invoice.paid`

## Functions

| Function | Role |
|----------|------|
| `create-checkout` | Checkout Session from cart. Missing key → `{ ok:false, reason:"stripe_not_configured" }`. |
| `stripe-webhook` | Verify signature; upsert orders/subs in Netlify Blobs |
| `create-portal` | Customer Portal session when keyed |
| `admin-login` / `admin-logout` | Username+password cookie session for `/admin/` |
| `admin-orders` / `admin-subscriptions` / `admin-fulfill` | List + mark fulfilled |

### Storefront without Stripe

Pay step shows **Payments coming online tonight** and disables checkout — no crash.

## Test card (test mode)

- `4242 4242 4242 4242` · any future expiry · any CVC · any ZIP

# Lead Reload HQ — deploy info

**Updated:** Thu Sep 24, 2026 (America/New_York)

> **Historical snapshot (pre-DNS).** Since this was written, `leadreloadhq.com` DNS + Let's Encrypt SSL went live, Force HTTPS is on, and `SITE_URL` is now `https://leadreloadhq.com`. See `PROJECT_BRIEF.md` for current state.

| Field | Value |
|-------|-------|
| Site name | `lead-reload-hq` |
| Site ID | `2d882b33-c92f-4484-acec-f2905d60fd83` |
| Production URL | https://lead-reload-hq.netlify.app |
| Admin UI | https://lead-reload-hq.netlify.app/admin/ |
| Custom domains (Netlify) | `leadreloadhq.com`, `www.leadreloadhq.com` |
| Team | Invictus Marketing Group |
| Publish dir | `public/` |
| Functions | `netlify/functions/` |

Existing mockup **effortless-nasturtium-30f8ff** was not modified.

## Env vars on this site

- `ADMIN_DAN_PASSWORD` / `ADMIN_ZAC_PASSWORD` — invite-only admin (values reported only to Webby)
- `ADMIN_PASSWORD` — optional legacy fallback (logs in as `dan`)
- `ADMIN_SESSION_SECRET` — set
- `SITE_URL` — still `https://lead-reload-hq.netlify.app` until custom-domain HTTPS works

Stripe keys still needed: see `STRIPE_SETUP.md`.

## Admin auth

Invite-only usernames: **dan**, **zac**. Login form requires username + password. Session stores username; UI shows signed-in user.

## Domain status (Netlify)

Both domains are **already attached** on the Netlify site:

- Primary: `leadreloadhq.com`
- Alias: `www.leadreloadhq.com`

DNS/SSL are **not live yet** (apex/www do not resolve to Netlify; TLS certificate pending DNS).  
`SITE_URL` remains the `*.netlify.app` URL until HTTPS on the custom domain succeeds.

## Ready for GoDaddy

At GoDaddy → **DNS** for `leadreloadhq.com`, set **exactly** these records.
Remove conflicting A / AAAA / CNAME records on `@` and `www` first.

| Type | Name / Host | Value | TTL |
|------|-------------|-------|-----|
| **A** | `@` | `75.2.60.5` | 600 (or default) |
| **CNAME** | `www` | `lead-reload-hq.netlify.app` | 600 (or default) |

### Preferred alternative for apex (if GoDaddy offers ALIAS / ANAME / flattened CNAME)

| Type | Name / Host | Value |
|------|-------------|-------|
| **ALIAS** / **ANAME** / flattened **CNAME** | `@` | `apex-loadbalancer.netlify.com` |
| **CNAME** | `www` | `lead-reload-hq.netlify.app` |

### Cleanup

- Delete any other **A** / **AAAA** records on `@` (IPv6 AAAA breaks Netlify SSL)
- Delete old parking / builder A records pointing away from Netlify
- Do **not** CNAME the apex to `lead-reload-hq.netlify.app` unless using a flattened/ALIAS feature

### After DNS propagates

1. Netlify provisions Let’s Encrypt HTTPS automatically (may take minutes–hours)
2. Confirm `https://leadreloadhq.com` and `https://www.leadreloadhq.com` load
3. Then update Netlify env `SITE_URL=https://leadreloadhq.com` and redeploy
4. Point Stripe webhook to `https://leadreloadhq.com/.netlify/functions/stripe-webhook`

## Smoke checks

- `GET /` → 200
- `GET /admin/` → 200 with username + password fields
- Dual-user login (`dan` / `zac`)
- `create-checkout` without Stripe → `stripe_not_configured`

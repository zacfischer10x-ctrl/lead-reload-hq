# Order confirmation email, Lead Reload HQ

Paid checkout sessions send one confirmation email. The webhook is `/.netlify/functions/stripe-webhook`. Nothing is sent for an abandoned or expired checkout, or for a session whose `payment_status` is not `paid`.

A Stripe retry of the same paid checkout does not send a second email. If the send fails, the order is still stored, fulfillment status is left as it was, and the webhook still returns `200`. The failure is logged and saved on the order as `confirmationEmail.status` (`failed` or `skipped`). Set the env vars below and redeliver that event from the Stripe Dashboard to try the email again.

Renewal invoices (`invoice.paid`) do not send this email. It is the confirmation for the checkout, not a message for every later week or month.

No email provider was in the repo. This uses the **Gmail API over HTTPS**, as a Google Workspace mailbox, with a service account and domain-wide delegation. The provider is one function in `netlify/functions/lib/email.js` (`PROVIDERS`). The webhook does not know about Gmail.

Gmail SMTP with an app password is not the sender. From a Netlify function that path often hits the 10 second function limit, and Google blocks SMTP logins that come from a data center. The Gmail call here is ordinary HTTPS and aborts after 8 seconds.

Planned mailbox: **support@leadreloadhq.com**. The address is only read from env vars. Do not put the service-account key in git. This repo is public.

## Env vars

Set these on the Netlify site `lead-reload-hq` (Site configuration → Environment variables). Redeploy after changing them so functions reload. Production is the context that serves leadreloadhq.com. You can use the same values locally for `node scripts/preview-order-email.js --send`.

| Name | Required to send | Value to use |
|---|---|---|
| `ORDER_EMAIL_PROVIDER` | No | `gmail-api` (the default). `off` stores orders and sends nothing. |
| `ORDER_EMAIL_FROM` | Yes | `Lead Reload HQ <support@leadreloadhq.com>` |
| `ORDER_EMAIL_REPLY_TO` | No | `support@leadreloadhq.com`. If unset, the address is taken from `ORDER_EMAIL_FROM`. |
| `GMAIL_IMPERSONATE` | No, when From contains the mailbox | `support@leadreloadhq.com`. This is the Workspace user the service account sends as. |
| `GMAIL_SERVICE_ACCOUNT_JSON` | Yes | The service-account JSON key, or its base64 (one line). See below. |
| `ORDER_EMAIL_BCC` | No | Comma-separated extra recipients, for example `dwhigham94@gmail.com,zacfischer10x@gmail.com`. Unset means no BCC. |

The From address has to be the impersonated mailbox, or a send-as alias of that user. Gmail rejects a From it does not own.

`GMAIL_SERVICE_ACCOUNT_JSON` is a secret. Base64 is the easier way to paste it into Netlify (the private key has many lines):

```bash
base64 -w 0 service-account.json
```

Delete the downloaded JSON from the laptop after it is in Netlify and a password manager. Do not commit it, and do not put it in GitHub.

## 1. Add the domain to Google Workspace

Dan's plan: add `leadreloadhq.com` to Zac's existing Workspace, and create a real user `support@leadreloadhq.com` so replies have a mailbox.

1. Sign in to [admin.google.com](https://admin.google.com) as a Workspace admin.
2. Account → Domains → Manage domains → Add a domain → `leadreloadhq.com`.
3. Choose to add it as a **secondary domain** (a real user at `@leadreloadhq.com`), not only as a domain alias of some other address.
4. Verify with a **TXT record**. Google shows a unique value (`google-site-verification=...`). Add that TXT at the host `@` in GoDaddy. Do not invent the value.
5. **Do not change the nameservers**, and do not pick the option that points the domain's nameservers at Google. DNS stays at GoDaddy. The website is the Netlify A record below. Changing nameservers takes the site off Netlify.
6. Directory → Users → Add user. Primary email `support@leadreloadhq.com`. Store that user's password in a password manager. The function never uses that password. The mailbox has to stay active so customer replies arrive.
7. After the MX record below is in place, activate Gmail for `leadreloadhq.com` (Account → Domains → Manage domains → Activate Gmail).

## 2. DNS at GoDaddy

DNS for `leadreloadhq.com` today (checked 2026-10-26):

| Type | Host | Value |
|---|---|---|
| A | `@` | `75.2.60.5` (Netlify). Leave this. |
| CNAME | `www` | `lead-reload-hq.netlify.app`. Leave this. |
| AAAA | `@` | none. Do not add one. |
| MX | `@` | none yet. |
| TXT | `@` | none yet (no SPF). |
| TXT | `_dmarc` | `v=DMARC1; p=quarantine; adkim=r; aspf=r; rua=mailto:dmarc_rua@onsecureserver.net;` |

That DMARC record is already `p=quarantine`. Mail that fails SPF or DKIM can go to spam until those two records are correct. Send a test (section 4) before any customer order. Do not delete the website A or CNAME records. MX does not replace them.

### Domain verification TXT

| Type | Host | Value |
|---|---|---|
| TXT | `@` | the `google-site-verification=...` string from the Admin console |

### MX (receive mail, including replies to support@)

| Type | Host | Priority | Value |
|---|---|---|---|
| MX | `@` | `1` | `smtp.google.com` |

Google's current MX is this one record. If GoDaddy adds a trailing dot (`smtp.google.com.`), leave the dot. Remove any other MX record. Then click Activate Gmail in the Admin console. Recognition can take up to 72 hours; it is often much faster.

### SPF (one TXT only)

| Type | Host | Value |
|---|---|---|
| TXT | `@` | `v=spf1 include:_spf.google.com ~all` |

There is no SPF record today, so this is safe to add. A domain may have only one TXT that starts with `v=spf1`. The verification TXT is a different record and can sit beside it. If some other sender is added later, add its `include:` to this same record. Do not create a second SPF TXT.

### DKIM

1. Admin console → Apps → Google Workspace → Gmail → Authenticate email.
2. Select `leadreloadhq.com`. Generate a new record. Use a **2048-bit** key.
3. Google shows a TXT host (usually `google._domainkey`) and a value that starts with `v=DKIM1; k=rsa; p=...`. Copy both. The `p=` value is unique. Do not invent one.
4. In GoDaddy, add a TXT record. Host: what Google shows. If Google shows `google._domainkey.leadreloadhq.com`, GoDaddy usually wants the host `google._domainkey` only.
5. If the value is very long, paste it as one TXT. Do not add extra quotes or line breaks.
6. Back in the Admin console, click **Start authentication**. Status should become "Authenticating email with DKIM". This can take up to 48 hours.

### DMARC (edit the record that is already there)

Do not add a second `_dmarc` TXT. Edit the existing one.

After a test message shows SPF pass and DKIM pass, set:

| Type | Host | Value |
|---|---|---|
| TXT | `_dmarc` | `v=DMARC1; p=quarantine; adkim=s; aspf=s; rua=mailto:support@leadreloadhq.com` |

`p=quarantine` matches the policy already published. The change is the report mailbox (today the reports go to GoDaddy at `dmarc_rua@onsecureserver.net`) and strict alignment, which matches mail From `support@leadreloadhq.com` signed by Google.

If the first test lands in spam while DNS is still propagating, you can use `p=none` for that window only, then put `p=quarantine` back. Leave quarantine in place once Authentication-Results shows `spf=pass` and `dkim=pass`.

## 3. Service account and domain-wide delegation

The key can send mail. It cannot read the mailbox, because the only scope granted is `https://www.googleapis.com/auth/gmail.send`. Domain-wide delegation still means that key can send **as any user in the Workspace** if someone has the key. Keep it in Netlify only. Do not grant `https://mail.google.com/` or any read/modify scope.

1. [Google Cloud Console](https://console.cloud.google.com/) → create a project, for example `lead-reload-hq-mail`.
2. APIs & Services → Library → **Gmail API** → Enable.
3. IAM & Admin → Service Accounts → Create service account. Name it `lead-reload-order-mail`. Do not give it a project role. The right to send is the Workspace delegation in step 6, not a GCP role.
4. Open the service account → Keys → Add key → Create new key → JSON. Download it once.
5. On the service account details page, copy the numeric **Unique ID** (Client ID). The same number is `client_id` inside the JSON. The delegation screen wants this number, not the service-account email.
6. Workspace Admin → Security → Access and data control → API controls → Domain-wide delegation → Manage Domain Wide Delegation → Add new.
   - Client ID: that numeric Unique ID
   - OAuth scopes: `https://www.googleapis.com/auth/gmail.send`
7. Base64 the JSON (command in the env section) and set `GMAIL_SERVICE_ACCOUNT_JSON` in Netlify, plus `ORDER_EMAIL_FROM` and `ORDER_EMAIL_REPLY_TO`.
8. Delegation can take a few minutes to apply.

## 4. Preview and test without a purchase

Copy only (no credentials, no send):

```bash
node scripts/preview-order-email.js
node scripts/preview-order-email.js --cadence weekly
node scripts/preview-order-email.js --cadence monthly
node scripts/preview-order-email.js --no-support
```

The sample order is General Life, 2,500 leads, Under 30 days, FL and TX, $1,300.00, October 26, 2026 (ET). `--no-support` shows the contact placeholder.

Automated checks (no network):

```bash
npm test
# or: node scripts/test-order-email.js
```

One real test message, after the env vars are in the shell and DNS can authenticate mail:

```bash
node scripts/preview-order-email.js --send zacfischer10x@gmail.com
```

The subject starts with `[Test]`. The body says no order was placed. Send it to a Gmail inbox that is **not** `support@leadreloadhq.com` (Google will not show DKIM results for a message you send to yourself). Open the message → More → Show original. Look for `spf=pass` and `dkim=pass` with `header.d=leadreloadhq.com` (or `d=leadreloadhq.com`).

Stripe test mode, after this code is on the site and the env vars are set (this pull request does not deploy):

1. Webhook endpoint `https://leadreloadhq.com/.netlify/functions/stripe-webhook`, test-mode signing secret in `STRIPE_WEBHOOK_SECRET`.
2. Events: `checkout.session.completed` (already required). Also add `checkout.session.async_payment_succeeded` if a delayed payment method should email when it later clears. Card payments are covered by `checkout.session.completed` with `payment_status` `paid`.
3. Card `4242 4242 4242 4242`, any future expiry, any CVC, any ZIP.
4. One email. Redeliver that event in the Stripe Dashboard: still one email.
5. Close the checkout without paying, or let it expire: no email.

`stripe trigger checkout.session.completed` is a poor test. The fixture is not a Lead Reload order and may not be `payment_status: paid`. Use the preview script, or a real test-mode checkout.

## Adding a different provider later

Add a function `(settings, envelope) => Promise<{ ok, id }>` to `PROVIDERS` in `netlify/functions/lib/email.js` and select it with `ORDER_EMAIL_PROVIDER`. Leave `stripe-webhook.js` alone. The order record remains the idempotency lock. Gmail does not offer an idempotency key on send.

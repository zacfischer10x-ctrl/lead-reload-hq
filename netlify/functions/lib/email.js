"use strict";

/**
 * Order-mail sender for Lead Reload HQ.
 *
 * The webhook calls sendEmail(). Providers are a map: the webhook does not
 * know which vendor sends. The built-in provider is "gmail-api" (HTTPS to
 * the Gmail API as a Google Workspace user, via a service account with
 * domain-wide delegation). That path stays inside a Netlify function's
 * timeout and does not depend on SMTP.
 *
 * SMTP with a Gmail app password is intentionally not implemented. From a
 * Netlify function it often times out, and Google blocks datacenter SMTP
 * logins. Add another provider by registering a function in PROVIDERS.
 * See ORDER_EMAIL.md.
 *
 * Secrets are read from Netlify env (Netlify.env, then process.env for
 * local tests). Nothing in this file is a credential.
 */

const crypto = require("crypto");

const GMAIL_SEND_SCOPE = "https://www.googleapis.com/auth/gmail.send";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const GMAIL_SEND_URL = "https://gmail.googleapis.com/gmail/v1/users";
const SEND_TIMEOUT_MS = 8000;

const ENV_NAMES = Object.freeze([
  "ORDER_EMAIL_PROVIDER",
  "ORDER_EMAIL_FROM",
  "ORDER_EMAIL_REPLY_TO",
  "ORDER_EMAIL_BCC",
  "GMAIL_IMPERSONATE",
  "GMAIL_SERVICE_ACCOUNT_JSON",
]);

let transportOverride = null;

function readEnv(name, source) {
  if (source) {
    const value = source[name];
    return value == null ? "" : String(value);
  }
  try {
    if (typeof Netlify !== "undefined" && Netlify.env && typeof Netlify.env.get === "function") {
      const fromNetlify = Netlify.env.get(name);
      if (fromNetlify != null && String(fromNetlify) !== "") return String(fromNetlify);
    }
  } catch (_) {
    // Local node (tests, preview script) has no Netlify global.
  }
  const fromProcess = process.env[name];
  return fromProcess == null ? "" : String(fromProcess);
}

function sanitizeHeader(value) {
  // First line only, so a buyer address cannot inject Bcc or other headers.
  return String(value || "").split(/[\r\n]/)[0].trim();
}

/**
 * Pull an email address out of "Name <a@b.com>" or "a@b.com".
 * Returns "" when the value is not a single address.
 */
function parseAddress(value) {
  const raw = sanitizeHeader(value);
  const angled = raw.match(/<([^<>]+)>/);
  const email = (angled ? angled[1] : raw).trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return "";
  return email;
}

function parseList(value) {
  return String(value || "")
    .split(",")
    .map((part) => parseAddress(part))
    .filter(Boolean);
}

function normalizePrivateKey(key) {
  let pem = String(key || "").trim();
  if (!pem.includes("-----")) return "";
  if (pem.includes("\\n")) pem = pem.replace(/\\n/g, "\n");
  return pem;
}

function parseServiceAccount(raw) {
  const text = String(raw || "").trim();
  if (!text) return null;
  let jsonText = text;
  if (!text.startsWith("{")) {
    try {
      jsonText = Buffer.from(text, "base64").toString("utf8").trim();
    } catch (_) {
      return null;
    }
  }
  let parsed;
  try {
    parsed = JSON.parse(jsonText);
  } catch (_) {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const clientEmail = parseAddress(parsed.client_email);
  const privateKey = normalizePrivateKey(parsed.private_key);
  if (!clientEmail || !privateKey) return null;
  return {
    client_email: clientEmail,
    private_key: privateKey,
    client_id: parsed.client_id ? String(parsed.client_id) : "",
  };
}

function resolveEmailSettings(source) {
  const provider = (readEnv("ORDER_EMAIL_PROVIDER", source) || "gmail-api").trim().toLowerCase();
  const from = sanitizeHeader(readEnv("ORDER_EMAIL_FROM", source));
  const impersonate =
    parseAddress(readEnv("GMAIL_IMPERSONATE", source)) || parseAddress(from);
  const replyTo = parseAddress(readEnv("ORDER_EMAIL_REPLY_TO", source)) || impersonate;
  const bcc = parseList(readEnv("ORDER_EMAIL_BCC", source));
  const serviceAccount = parseServiceAccount(readEnv("GMAIL_SERVICE_ACCOUNT_JSON", source));
  const disabled = provider === "off" || provider === "none";
  const missing = [];
  if (!from) missing.push("ORDER_EMAIL_FROM");
  if (!impersonate) missing.push("GMAIL_IMPERSONATE");
  if (!serviceAccount) missing.push("GMAIL_SERVICE_ACCOUNT_JSON");
  return {
    provider,
    disabled,
    from,
    replyTo,
    impersonate,
    bcc,
    serviceAccount,
    missing,
    configured: provider === "gmail-api" && missing.length === 0,
  };
}

function base64url(input) {
  const buf = Buffer.isBuffer(input) ? input : Buffer.from(String(input));
  return buf.toString("base64").replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}

function signServiceAccountJwt(account, subject) {
  const now = Math.floor(Date.now() / 1000);
  const header = base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = base64url(
    JSON.stringify({
      iss: account.client_email,
      scope: GMAIL_SEND_SCOPE,
      aud: TOKEN_URL,
      iat: now - 30,
      exp: now + 3600,
      sub: subject,
    })
  );
  const unsigned = `${header}.${payload}`;
  const signature = crypto.createSign("RSA-SHA256").update(unsigned).sign(account.private_key);
  return `${unsigned}.${base64url(signature)}`;
}

function wrapBase64(text) {
  return Buffer.from(String(text), "utf8")
    .toString("base64")
    .replace(/(.{76})/g, "$1\r\n")
    .replace(/\s+$/g, "");
}

/**
 * multipart/alternative MIME (plain text + HTML). CRLF, headers sanitized.
 * BCC is a header only. Gmail removes it from the copy the buyer receives.
 */
function buildMimeMessage(envelope) {
  const boundary = `lr_${crypto.randomBytes(16).toString("hex")}`;
  const headers = [
    `From: ${sanitizeHeader(envelope.from)}`,
    `To: ${sanitizeHeader(envelope.to)}`,
  ];
  if (envelope.replyTo) headers.push(`Reply-To: ${sanitizeHeader(envelope.replyTo)}`);
  if (envelope.bcc && envelope.bcc.length) {
    headers.push(`Bcc: ${envelope.bcc.map(sanitizeHeader).join(", ")}`);
  }
  headers.push(
    `Subject: ${sanitizeHeader(envelope.subject)}`,
    "MIME-Version: 1.0",
    `Content-Type: multipart/alternative; boundary="${boundary}"`
  );
  const part = (type, body) =>
    [
      `--${boundary}`,
      `Content-Type: ${type}; charset=UTF-8`,
      "Content-Transfer-Encoding: base64",
      "",
      wrapBase64(body),
      "",
    ].join("\r\n");
  return `${headers.join("\r\n")}\r\n\r\n${part("text/plain", envelope.text)}\r\n${part(
    "text/html",
    envelope.html
  )}\r\n--${boundary}--\r\n`;
}

function abortSignal() {
  if (typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function") {
    return AbortSignal.timeout(SEND_TIMEOUT_MS);
  }
  return undefined;
}

async function readJson(response) {
  const text = await response.text();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch (_) {
    return {};
  }
}

function safeError(value) {
  const text = String(value && value.message ? value.message : value || "")
    .replace(/[\r\n]+/g, " ")
    .slice(0, 180);
  if (/private key|BEGIN [A-Z ]*PRIVATE KEY/i.test(text)) return "redacted";
  return text;
}

function googleError(body) {
  if (!body || typeof body !== "object") return "";
  if (body.error && typeof body.error === "object") return safeError(body.error.message || body.error.status || "");
  if (typeof body.error === "string") return safeError(body.error_description || body.error);
  return "";
}

async function sendViaGmailApi(settings, envelope) {
  try {
    const assertion = signServiceAccountJwt(settings.serviceAccount, settings.impersonate);
    const tokenRes = await fetch(TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
        assertion,
      }),
      signal: abortSignal(),
    });
    const tokenBody = await readJson(tokenRes);
    if (!tokenRes.ok || !tokenBody.access_token) {
      return {
        ok: false,
        reason: "email_send_failed",
        message: googleError(tokenBody) || `token_http_${tokenRes.status}`,
      };
    }

    // idempotencyKey is enforced by the order record, not by Gmail.
    const raw = base64url(buildMimeMessage(envelope));
    const sendUrl = `${GMAIL_SEND_URL}/${encodeURIComponent(settings.impersonate)}/messages/send`;
    const sendRes = await fetch(sendUrl, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${tokenBody.access_token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ raw }),
      signal: abortSignal(),
    });
    const sendBody = await readJson(sendRes);
    if (!sendRes.ok) {
      return {
        ok: false,
        reason: "email_send_failed",
        message: googleError(sendBody) || `gmail_http_${sendRes.status}`,
      };
    }
    return { ok: true, id: sendBody.id || null };
  } catch (err) {
    return { ok: false, reason: "email_send_failed", message: safeError(err) };
  }
}

const PROVIDERS = {
  "gmail-api": sendViaGmailApi,
};

function envelopeFrom(settings, message) {
  return {
    from: sanitizeHeader(settings.from),
    to: sanitizeHeader(message.to),
    replyTo: sanitizeHeader(settings.replyTo),
    bcc: settings.bcc,
    subject: sanitizeHeader(message.subject),
    text: String(message.text || ""),
    html: String(message.html || ""),
    idempotencyKey: sanitizeHeader(message.idempotencyKey),
  };
}

/**
 * @returns {Promise<{ok: boolean, id?: string|null, skipped?: boolean, reason?: string, message?: string, missing?: string[]}>}
 */
async function sendEmail(message) {
  const settings = resolveEmailSettings();
  const envelope = envelopeFrom(settings, message || {});
  if (transportOverride) {
    const out = await transportOverride(envelope);
    if (out && out.ok) return { ok: true, id: out.id || null };
    return {
      ok: false,
      skipped: !!(out && out.skipped),
      reason: (out && out.reason) || "email_send_failed",
      message: out && out.message ? safeError(out.message) : "",
    };
  }
  if (settings.disabled) return { ok: false, skipped: true, reason: "email_disabled" };
  if (settings.provider !== "gmail-api") {
    return { ok: false, skipped: true, reason: "unsupported_provider" };
  }
  if (!settings.configured) {
    return { ok: false, skipped: true, reason: "email_not_configured", missing: settings.missing };
  }
  const provider = PROVIDERS[settings.provider];
  return provider(settings, envelope);
}

function setTransportForTests(fn) {
  transportOverride = typeof fn === "function" ? fn : null;
}

module.exports = {
  ENV_NAMES,
  GMAIL_SEND_SCOPE,
  TOKEN_URL,
  sendEmail,
  resolveEmailSettings,
  parseAddress,
  parseServiceAccount,
  setTransportForTests,
  buildMimeMessage,
  signServiceAccountJwt,
};

"use strict";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Credentials": "true",
};

// Admin responses are per-user: never cache them anywhere.
const ADMIN_NO_STORE = {
  "Cache-Control": "private, no-store, max-age=0",
  "Netlify-CDN-Cache-Control": "no-store",
  Vary: "Authorization",
};

function json(statusCode, body, extraHeaders = {}) {
  return {
    statusCode,
    headers: {
      "Content-Type": "application/json",
      ...CORS,
      ...extraHeaders,
    },
    body: JSON.stringify(body),
  };
}

function text(statusCode, body, extraHeaders = {}) {
  return {
    statusCode,
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      ...CORS,
      ...extraHeaders,
    },
    body: String(body),
  };
}

function options() {
  return { statusCode: 204, headers: { ...CORS }, body: "" };
}

function parseBody(event) {
  if (!event.body) return {};
  const raw = event.isBase64Encoded
    ? Buffer.from(event.body, "base64").toString("utf8")
    : event.body;
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

function siteUrl(event) {
  if (process.env.SITE_URL) return process.env.SITE_URL.replace(/\/$/, "");
  const proto = event.headers["x-forwarded-proto"] || "https";
  const host = event.headers["x-forwarded-host"] || event.headers.host;
  return `${proto}://${host}`;
}

module.exports = { json, text, options, parseBody, siteUrl, CORS, ADMIN_NO_STORE };

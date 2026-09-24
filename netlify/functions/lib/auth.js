"use strict";

const crypto = require("crypto");
const { parse: parseCookie, serialize } = require("cookie");

const COOKIE_NAME = "lr_admin_session";
const MAX_AGE_SEC = 60 * 60 * 24 * 7;
const ALLOWED_USERS = new Set(["dan", "zac"]);

function sessionSecret() {
  return (
    process.env.ADMIN_SESSION_SECRET ||
    crypto
      .createHash("sha256")
      .update(
        "lr-admin|" +
          (process.env.ADMIN_DAN_PASSWORD ||
            process.env.ADMIN_PASSWORD ||
            "unset")
      )
      .digest("hex")
  );
}

function sign(payload) {
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const sig = crypto
    .createHmac("sha256", sessionSecret())
    .update(body)
    .digest("base64url");
  return `${body}.${sig}`;
}

function verify(token) {
  if (!token || typeof token !== "string" || !token.includes(".")) return null;
  const [body, sig] = token.split(".");
  const expected = crypto
    .createHmac("sha256", sessionSecret())
    .update(body)
    .digest("base64url");
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
    if (!payload || payload.exp < Date.now()) return null;
    if (!payload.user || !ALLOWED_USERS.has(String(payload.user).toLowerCase())) {
      return null;
    }
    return payload;
  } catch {
    return null;
  }
}

function safeEqual(provided, expected) {
  if (!expected) return false;
  const a = Buffer.from(String(provided || ""));
  const b = Buffer.from(String(expected));
  if (a.length !== b.length) {
    crypto.timingSafeEqual(Buffer.alloc(b.length), b);
    return false;
  }
  return crypto.timingSafeEqual(a, b);
}

function adminConfigured() {
  return Boolean(
    process.env.ADMIN_DAN_PASSWORD ||
      process.env.ADMIN_ZAC_PASSWORD ||
      process.env.ADMIN_PASSWORD
  );
}

/**
 * Invite-only: usernames dan | zac (case-insensitive).
 * Passwords from ADMIN_DAN_PASSWORD / ADMIN_ZAC_PASSWORD.
 * Legacy ADMIN_PASSWORD still authenticates as dan.
 */
function authenticateUser(username, password) {
  const user = String(username || "")
    .trim()
    .toLowerCase();
  if (!ALLOWED_USERS.has(user)) return null;

  if (user === "dan") {
    if (safeEqual(password, process.env.ADMIN_DAN_PASSWORD)) return "dan";
    // Transition fallback — shared legacy password maps to dan
    if (safeEqual(password, process.env.ADMIN_PASSWORD)) return "dan";
    return null;
  }
  if (user === "zac") {
    if (safeEqual(password, process.env.ADMIN_ZAC_PASSWORD)) return "zac";
    return null;
  }
  return null;
}

function createSessionCookie(username) {
  const user = String(username || "")
    .trim()
    .toLowerCase();
  if (!ALLOWED_USERS.has(user)) {
    throw new Error("invalid_admin_user");
  }
  const token = sign({
    role: "admin",
    user,
    exp: Date.now() + MAX_AGE_SEC * 1000,
  });
  return serialize(COOKIE_NAME, token, {
    httpOnly: true,
    secure: true,
    sameSite: "lax",
    path: "/",
    maxAge: MAX_AGE_SEC,
  });
}

function clearSessionCookie() {
  return serialize(COOKIE_NAME, "", {
    httpOnly: true,
    secure: true,
    sameSite: "lax",
    path: "/",
    maxAge: 0,
  });
}

function getSession(event) {
  const raw = event.headers.cookie || event.headers.Cookie || "";
  const cookies = parseCookie(raw);
  return verify(cookies[COOKIE_NAME]);
}

function requireAdmin(event) {
  const session = getSession(event);
  if (!session) return { ok: false, statusCode: 401, error: "unauthorized" };
  return { ok: true, session };
}

// Legacy helper kept for any callers; prefer authenticateUser
function checkPassword(password) {
  return Boolean(authenticateUser("dan", password));
}

module.exports = {
  COOKIE_NAME,
  ALLOWED_USERS,
  createSessionCookie,
  clearSessionCookie,
  getSession,
  requireAdmin,
  authenticateUser,
  adminConfigured,
  checkPassword,
};

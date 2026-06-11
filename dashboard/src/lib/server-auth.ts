import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Server-side session helpers shared by the auth route and the runner proxy.
 *
 * The session token is an HMAC-SHA256 of a static context string keyed by the
 * dashboard password. It is deterministic, so sessions survive server
 * restarts, and it never contains (or reveals) the runner secret.
 */

const SESSION_CONTEXT = "meshwork-dashboard-session-v1";

export const SESSION_COOKIE_NAME = "meshwork_session";

/** Derive the session token from DASHBOARD_PASSWORD. Returns null if unset. */
export function createSessionToken(): string | null {
  const password = process.env.DASHBOARD_PASSWORD;
  if (!password) return null;
  return createHmac("sha256", password).update(SESSION_CONTEXT).digest("hex");
}

/** Constant-time string comparison. */
export function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

/** Verify the session cookie on an incoming request. */
export function verifySessionCookie(req: Request): boolean {
  const expected = createSessionToken();
  if (!expected) return false;

  const cookieHeader = req.headers.get("cookie");
  if (!cookieHeader) return false;

  for (const part of cookieHeader.split(";")) {
    const [name, ...rest] = part.trim().split("=");
    if (name === SESSION_COOKIE_NAME) {
      const value = decodeURIComponent(rest.join("="));
      if (safeEqual(value, expected)) return true;
    }
  }
  return false;
}

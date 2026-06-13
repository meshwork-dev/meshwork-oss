import { NextRequest, NextResponse } from "next/server";
import {
  createSessionToken,
  safeEqual,
  verifySessionCookie,
  SESSION_COOKIE_NAME,
} from "@/lib/server-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const SESSION_MAX_AGE_SECONDS = 60 * 60 * 24 * 7; // 7 days

/**
 * In-memory login rate limiter: max attempts per IP per window. The dashboard
 * has a single static password, so brute-force protection has to live here.
 * Survives for the lifetime of the server process, which is sufficient — an
 * attacker who can restart the server doesn't need the password.
 */
const LOGIN_MAX_ATTEMPTS = Number(process.env.LOGIN_MAX_ATTEMPTS || 5);
const LOGIN_WINDOW_MS = Number(process.env.LOGIN_WINDOW_MS || 60_000);
const loginAttempts = new Map<string, { count: number; resetAt: number }>();

function clientIp(req: NextRequest): string {
  const fwd = req.headers.get("x-forwarded-for");
  if (fwd) return fwd.split(",")[0].trim();
  return req.headers.get("x-real-ip") || "unknown";
}

function loginRateLimited(ip: string): boolean {
  const now = Date.now();
  const entry = loginAttempts.get(ip);
  if (!entry || now >= entry.resetAt) {
    loginAttempts.set(ip, { count: 1, resetAt: now + LOGIN_WINDOW_MS });
    // Opportunistic cleanup so the map can't grow unbounded
    if (loginAttempts.size > 10_000) {
      for (const [k, v] of loginAttempts) {
        if (now >= v.resetAt) loginAttempts.delete(k);
      }
    }
    return false;
  }
  entry.count += 1;
  return entry.count > LOGIN_MAX_ATTEMPTS;
}

function cookieOptions() {
  // Default: secure in production. Override with COOKIE_SECURE=false for
  // plain-HTTP deployments (e.g. internal LAN without TLS).
  const secure =
    process.env.COOKIE_SECURE !== undefined
      ? process.env.COOKIE_SECURE !== "false"
      : process.env.NODE_ENV === "production";
  return {
    httpOnly: true,
    sameSite: "lax" as const,
    path: "/",
    secure,
  };
}

/**
 * POST /api/auth — validate dashboard password and set an httpOnly session
 * cookie. The runner secret never leaves the server.
 */
export async function POST(req: NextRequest) {
  const ip = clientIp(req);
  if (loginRateLimited(ip)) {
    console.warn(`[auth] Login rate limit exceeded for ${ip}`);
    return NextResponse.json(
      { error: "Too many login attempts. Try again in a minute." },
      { status: 429, headers: { "retry-after": "60" } }
    );
  }

  let password: unknown;
  try {
    ({ password } = await req.json());
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }

  const dashboardPassword = process.env.DASHBOARD_PASSWORD;
  if (!dashboardPassword) {
    return NextResponse.json(
      { error: "DASHBOARD_PASSWORD not configured on server" },
      { status: 500 }
    );
  }

  if (typeof password !== "string" || !safeEqual(password, dashboardPassword)) {
    return NextResponse.json({ error: "Invalid password" }, { status: 401 });
  }

  const token = createSessionToken();
  if (!token) {
    return NextResponse.json(
      { error: "Session token could not be created" },
      { status: 500 }
    );
  }

  const res = NextResponse.json({ ok: true });
  res.cookies.set(SESSION_COOKIE_NAME, token, {
    ...cookieOptions(),
    maxAge: SESSION_MAX_AGE_SECONDS,
  });
  return res;
}

/**
 * GET /api/auth — lightweight session check. 200 when the session cookie is
 * valid, 401 otherwise.
 */
export async function GET(req: NextRequest) {
  if (verifySessionCookie(req)) {
    return NextResponse.json({ ok: true });
  }
  return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
}

/**
 * DELETE /api/auth — logout; clears the session cookie.
 */
export async function DELETE() {
  const res = NextResponse.json({ ok: true });
  res.cookies.set(SESSION_COOKIE_NAME, "", {
    ...cookieOptions(),
    maxAge: 0,
  });
  return res;
}

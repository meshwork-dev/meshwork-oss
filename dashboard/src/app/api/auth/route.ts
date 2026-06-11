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

function cookieOptions() {
  return {
    httpOnly: true,
    sameSite: "lax" as const,
    path: "/",
    secure: process.env.NODE_ENV === "production",
  };
}

/**
 * POST /api/auth — validate dashboard password and set an httpOnly session
 * cookie. The runner secret never leaves the server.
 */
export async function POST(req: NextRequest) {
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

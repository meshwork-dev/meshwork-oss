import { NextRequest, NextResponse } from "next/server";

/**
 * POST /api/auth - Validate dashboard password, return runner secret
 * Dashboard password is user-facing. Runner secret stays server-side.
 */
export async function POST(req: NextRequest) {
  const { password } = await req.json();
  const dashboardPassword = process.env.DASHBOARD_PASSWORD;

  if (!dashboardPassword) {
    return NextResponse.json(
      { error: "DASHBOARD_PASSWORD not configured on server" },
      { status: 500 }
    );
  }

  if (password !== dashboardPassword) {
    return NextResponse.json({ error: "Invalid password" }, { status: 401 });
  }

  // Return the runner secret so the client can call the runner API directly
  const runnerSecret = process.env.RUNNER_SECRET;
  if (!runnerSecret) {
    return NextResponse.json(
      { error: "RUNNER_SECRET not configured on server" },
      { status: 500 }
    );
  }

  return NextResponse.json({ runnerSecret });
}

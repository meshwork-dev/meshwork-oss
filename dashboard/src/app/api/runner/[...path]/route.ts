import { NextRequest } from "next/server";
import { verifySessionCookie } from "@/lib/server-auth";

/**
 * Server-side proxy for the runner API.
 *
 * The browser never sees the runner secret: requests are authenticated with
 * the httpOnly session cookie, and the secret is attached server-side.
 * Responses are streamed back so SSE (/events) and log streams work.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function runnerBaseUrl(): string {
  return (process.env.RUNNER_URL || "http://localhost:3210").replace(/\/+$/, "");
}

async function proxy(
  req: NextRequest,
  ctx: { params: Promise<{ path: string[] }> }
): Promise<Response> {
  if (!verifySessionCookie(req)) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  const secret = process.env.RUNNER_SECRET;
  if (!secret) {
    return Response.json(
      { error: "RUNNER_SECRET not configured on server" },
      { status: 500 }
    );
  }

  const { path } = await ctx.params;

  // Preserve the original query string, but never forward any client-supplied
  // secret to (or beyond) the runner.
  const search = new URLSearchParams(req.nextUrl.searchParams);
  search.delete("secret");
  const query = search.toString();

  const url = `${runnerBaseUrl()}/${path.map(encodeURIComponent).join("/")}${query ? `?${query}` : ""}`;

  const headers: Record<string, string> = { "x-runner-secret": secret };
  const contentType = req.headers.get("content-type");
  if (contentType) headers["content-type"] = contentType;
  const accept = req.headers.get("accept");
  if (accept) headers["accept"] = accept;

  const hasBody = req.method !== "GET" && req.method !== "HEAD";
  const body = hasBody ? await req.arrayBuffer() : undefined;

  let upstream: Response;
  try {
    upstream = await fetch(url, {
      method: req.method,
      headers,
      body: body && body.byteLength > 0 ? body : undefined,
      cache: "no-store",
      // Abort the upstream request when the client disconnects (important for
      // long-lived SSE/log streams).
      signal: req.signal,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return Response.json(
      { error: `Runner unreachable: ${message}` },
      { status: 502 }
    );
  }

  const responseHeaders = new Headers();
  const upstreamContentType = upstream.headers.get("content-type");
  if (upstreamContentType) responseHeaders.set("content-type", upstreamContentType);
  const contentDisposition = upstream.headers.get("content-disposition");
  if (contentDisposition) responseHeaders.set("content-disposition", contentDisposition);
  responseHeaders.set("cache-control", "no-cache, no-transform");
  if (upstreamContentType?.includes("text/event-stream")) {
    // Disable proxy buffering so SSE events flush immediately.
    responseHeaders.set("x-accel-buffering", "no");
  }

  // Stream the upstream body back without buffering.
  return new Response(upstream.body, {
    status: upstream.status,
    headers: responseHeaders,
  });
}

export {
  proxy as GET,
  proxy as POST,
  proxy as PUT,
  proxy as PATCH,
  proxy as DELETE,
};

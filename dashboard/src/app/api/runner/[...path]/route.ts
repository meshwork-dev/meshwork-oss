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

/**
 * Only known runner API surfaces are proxied. Anything else — notably
 * /internal/* (the runner's subprocess-only consult endpoint) and any
 * future admin endpoints — is rejected instead of blindly forwarded.
 * Extend per-deployment with RUNNER_PROXY_EXTRA_PREFIXES (comma-separated
 * first path segments).
 */
const ALLOWED_PATH_PREFIXES = new Set([
  "agent",
  "agents",
  "api",
  "batches",
  "chat",
  "dashboard",
  "events",
  "health",
  "jobs",
  "meeting",
  "meetings",
  "pipeline",
  "pipelines",
  "run",
  "schedule",
  "scheduled",
  ...(process.env.RUNNER_PROXY_EXTRA_PREFIXES || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
]);

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

  if (!path?.length || !ALLOWED_PATH_PREFIXES.has(path[0])) {
    return Response.json(
      { error: `Path not allowed through runner proxy: /${(path || []).join("/")}` },
      { status: 403 }
    );
  }

  // Preserve the original query string, but never forward any client-supplied
  // secret to (or beyond) the runner.
  const search = new URLSearchParams(req.nextUrl.searchParams);
  search.delete("secret");
  const query = search.toString();

  const url = `${runnerBaseUrl()}/${path.map(encodeURIComponent).join("/")}${query ? `?${query}` : ""}`;

  const headers: Record<string, string> = { "x-runner-secret": secret };
  const rawContentType = req.headers.get("content-type");
  // Take only the first value — duplicate headers (e.g. "application/json, application/json")
  // cause Express body-parser to skip parsing, leaving req.body empty.
  const contentType = rawContentType ? rawContentType.split(",")[0].trim() : null;
  const hasBody = req.method !== "GET" && req.method !== "HEAD";
  headers["content-type"] = contentType || (hasBody ? "application/json" : "");
  if (!headers["content-type"]) delete headers["content-type"];
  const accept = req.headers.get("accept");
  if (accept) headers["accept"] = accept;

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

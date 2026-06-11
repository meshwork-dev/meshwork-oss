/**
 * Client-side auth helpers. The session lives in an httpOnly cookie set by
 * /api/auth — the browser never holds the runner secret. Auth state on the
 * client is simply "logged in or not", verified against GET /api/auth.
 */

/** Check whether the current session cookie is valid. */
export async function checkSession(): Promise<boolean> {
  try {
    const res = await fetch("/api/auth", { method: "GET", cache: "no-store" });
    return res.ok;
  } catch (err) {
    console.warn("[auth] Session check failed:", err);
    return false;
  }
}

/** Log in with the dashboard password. The server sets the session cookie. */
export async function login(password: string): Promise<{ ok: boolean; error?: string }> {
  const res = await fetch("/api/auth", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ password }),
  });
  if (res.ok) return { ok: true };
  const data = await res.json().catch(() => ({}));
  return { ok: false, error: data.error || "Invalid password" };
}

/** Log out: ask the server to clear the session cookie. */
export async function logout(): Promise<void> {
  try {
    await fetch("/api/auth", { method: "DELETE" });
  } catch (err) {
    console.warn("[auth] Logout request failed:", err);
  }
}

/**
 * Fire-and-forget variant kept for call sites that immediately reload the
 * page (e.g. on a 401 from the proxy).
 */
export function clearAuth() {
  if (typeof window === "undefined") return;
  void fetch("/api/auth", { method: "DELETE" }).catch((err) => {
    console.warn("[auth] Failed to clear session cookie:", err);
  });
}

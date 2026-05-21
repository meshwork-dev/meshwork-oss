const SECRET_KEY = "orchestracode-runner-secret";
const AUTH_KEY = "orchestracode-authenticated";

export function getRunnerSecret(): string | null {
  if (typeof window === "undefined") return null;
  return sessionStorage.getItem(SECRET_KEY);
}

export function setRunnerSecret(secret: string) {
  sessionStorage.setItem(SECRET_KEY, secret);
  localStorage.setItem(AUTH_KEY, "1");
}

export function isAuthenticated(): boolean {
  if (typeof window === "undefined") return false;
  return sessionStorage.getItem(SECRET_KEY) !== null;
}

export function clearAuth() {
  sessionStorage.removeItem(SECRET_KEY);
  localStorage.removeItem(AUTH_KEY);
}

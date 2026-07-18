/**
 * Last resolved auth outcome (`nw:auth-status-v1`), used to seed `AuthProvider` optimistically
 * so the app (or the login page, on a gated deployment) paints before `/api/auth/status`
 * resolves. `gated` = the last resolution ended on the login gate (auth required, no valid
 * session). A stale entry is corrected within one round-trip by the live status response;
 * absent (first-ever visit) the provider defaults to the login gate.
 */
export type AuthStatusCacheEntry = { auth_required: boolean; gated: boolean };

const STORAGE_KEY = "nw:auth-status-v1";

export function readAuthStatusCache(): AuthStatusCacheEntry | undefined {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return undefined;
    const parsed = JSON.parse(raw) as AuthStatusCacheEntry;
    if (typeof parsed.auth_required !== "boolean" || typeof parsed.gated !== "boolean") {
      return undefined;
    }
    return parsed;
  } catch {
    return undefined;
  }
}

export function writeAuthStatusCache(entry: AuthStatusCacheEntry): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(entry));
  } catch {
    // quota / private mode
  }
}

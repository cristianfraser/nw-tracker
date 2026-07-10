/**
 * Prod version introspection from the browser console:
 *
 *   await window.nwVersion()
 *   → { client: {...}, server: {...}, match: true }
 *
 * `client` is baked into this bundle at build time (Vite `define`); `server` is
 * fetched from /api/health (auth-exempt, so it works pre-login). A `match: false`
 * means the browser is running a stale cached bundle against a newer server.
 * See scripts/version-info.mjs for the version scheme.
 */
export const clientVersion: NwVersionInfo = __NW_CLIENT_VERSION__;

export function installVersionConsoleHelper(): void {
  window.nwVersion = async () => {
    const res = await fetch("/api/health");
    if (!res.ok) throw new Error(`/api/health returned ${res.status}`);
    const server = (await res.json()).version as NwVersionInfo;
    return { client: clientVersion, server, match: server.sha === clientVersion.sha };
  };
  console.info(
    `nw-tracker client ${clientVersion.version} — run window.nwVersion() for client + server versions`
  );
}

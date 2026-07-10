/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_API_URL: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

/** App version info, shape shared with the server. See scripts/version-info.mjs. */
interface NwVersionInfo {
  readonly version: string;
  readonly sha: string;
  readonly commitAt: string;
  readonly dirty: boolean;
  readonly resolvedAt: string;
}

/** Baked into the bundle by Vite `define` (client/vite.config.ts) at build time. */
declare const __NW_CLIENT_VERSION__: NwVersionInfo;

interface Window {
  /** Console helper: `await window.nwVersion()` → client + server versions on prod. */
  nwVersion: () => Promise<{
    client: NwVersionInfo;
    server: NwVersionInfo;
    match: boolean;
  }>;
}

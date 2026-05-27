import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export type GlobalSyncStateFile = {
  unoLastSpotYmd?: string;
  /** Last AFP spot unit row written (for carry-forward if DB is sparse). */
  afpLastUnitDay?: string;
  afpLastUnitClp?: number;
  /** Last Chile calendar day we applied Fintual NAV (after 18:00 policy). */
  fintualLastAppliedYmd?: string;
  /** Fund cuota publish date (`as_of_date`) at last apply — may be before poll calendar day. */
  fintualLastAppliedPublishYmd?: string;
  /** Signature of mapped goals' NAV at last apply (stable ordering). */
  fintualLastAppliedSig?: string;
  /** Last Chile day we attempted Fintual fetch after 18:00 (even if no DB change). */
  fintualLastCheckYmd?: string;
  /** Fund publish date resolved at last post-18:00 poll. */
  fintualLastPublishYmd?: string;
  /** Mapped-goals NAV signature at the last post-18:00 poll (see {@link isFintualSyncStale}). */
  fintualLastCheckSig?: string;
  /** Chile day when post-18:00 Fintual poll matched DB for both prior-day and today `as_of`. */
  fintualEveningSettledYmd?: string;
  /** `YYYY-MM` SBIF UF incremental sync succeeded for. */
  sbifUfMonth?: string;
  sbifUtmMonth?: string;
  sbifIpcMonth?: string;
  /** ISO timestamp of last failed BCentral dólar observado fetch (cleared on success). */
  sbifUsdLastErrorAt?: string;
  /** ISO timestamp of last failed BCentral euro observado fetch (cleared on success). */
  sbifEurLastErrorAt?: string;
  /** Last NYSE session date we synced EOD for SPY/VEA. */
  equityEodLastNySessionYmd?: string;
  /** Last UTC day we synced crypto EOD. */
  equityEodLastCryptoUtcYmd?: string;
  /** Sources marked stale from the sync log UI until the next successful sync step. */
  userForcedStale?: string[];
};

export function globalSyncStatePath(): string {
  return path.join(__dirname, "..", "data", ".global-sync-state.json");
}

function migrateUserForcedStaleSources(list: string[] | undefined): string[] | undefined {
  if (!list?.includes("equity_eod")) return list;
  const out = new Set<string>();
  for (const s of list) {
    if (s === "equity_eod") {
      out.add("stocks_nyse");
      out.add("crypto_eod");
    } else {
      out.add(s);
    }
  }
  return [...out];
}

function migrateLoadedState(state: GlobalSyncStateFile): GlobalSyncStateFile {
  const userForcedStale = migrateUserForcedStaleSources(state.userForcedStale);
  if (userForcedStale === state.userForcedStale) return state;
  return { ...state, userForcedStale };
}

export function loadGlobalSyncState(): GlobalSyncStateFile {
  const p = globalSyncStatePath();
  if (!fs.existsSync(p)) return {};
  try {
    const raw = JSON.parse(fs.readFileSync(p, "utf8")) as unknown;
    if (!raw || typeof raw !== "object") return {};
    return migrateLoadedState(raw as GlobalSyncStateFile);
  } catch {
    return {};
  }
}

export function saveGlobalSyncState(state: GlobalSyncStateFile): void {
  const p = globalSyncStatePath();
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(state, null, 2) + "\n", "utf8");
}

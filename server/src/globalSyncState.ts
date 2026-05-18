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
  /** Signature of mapped goals' NAV at last apply (stable ordering). */
  fintualLastAppliedSig?: string;
  /** Last Chile day we attempted Fintual fetch after 18:00 (even if no DB change). */
  fintualLastCheckYmd?: string;
  /** `YYYY-MM` SBIF UF incremental sync succeeded for. */
  sbifUfMonth?: string;
  sbifUtmMonth?: string;
  sbifIpcMonth?: string;
};

export function globalSyncStatePath(): string {
  return path.join(__dirname, "..", "data", ".global-sync-state.json");
}

export function loadGlobalSyncState(): GlobalSyncStateFile {
  const p = globalSyncStatePath();
  if (!fs.existsSync(p)) return {};
  try {
    const raw = JSON.parse(fs.readFileSync(p, "utf8")) as unknown;
    if (!raw || typeof raw !== "object") return {};
    return raw as GlobalSyncStateFile;
  } catch {
    return {};
  }
}

export function saveGlobalSyncState(state: GlobalSyncStateFile): void {
  const p = globalSyncStatePath();
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(state, null, 2) + "\n", "utf8");
}

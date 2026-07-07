/**
 * Fintual “certificado de transacciones” v2 accounts: cuotas in movements, valor cuota in fund_unit_daily.
 * Parallel to legacy `import:excel|key=…` accounts until manually removed.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assetGroupBySlug } from "./assetGroupTree.js";
import { assetGroupIdForImportKind } from "./portfolioGroupTree.js";

export const FINTUAL_CERT_V2_GOAL_IDS: Record<string, string> = {
  "2859": "import:fintual|cert|key=risky_norris",
  "16749": "import:fintual|cert|key=apv_a",
  "78515": "import:fintual|cert|key=apv_b",
  "1164983": "import:fintual|cert|key=reserva2",
};

export const FINTUAL_CERT_V2_ACCOUNT_NAMES: Record<string, string> = {
  "import:fintual|cert|key=reserva2": "Reserva2",
  "import:fintual|cert|key=risky_norris": "caca daca",
  "import:fintual|cert|key=apv_a": "mega caca",
  "import:fintual|cert|key=apv_b": "mega cbcb",
};

export const FINTUAL_CERT_V2_CATEGORY_SLUG: Record<string, string> = {
  "import:fintual|cert|key=reserva2": "fondo_reserva",
  "import:fintual|cert|key=risky_norris": "fintual_risky_norris",
  /** Distinct kind slugs — `apv` alone matches both `retirement_apv_a__apv` and `retirement_apv_b__apv` (tie → apv-b). */
  "import:fintual|cert|key=apv_a": "apv_a",
  "import:fintual|cert|key=apv_b": "apv_b",
};

export const FINTUAL_CERT_V2_SERIES_KEY: Record<string, string> = {
  "import:fintual|cert|key=reserva2": "fintual_cert_reserva2",
  "import:fintual|cert|key=risky_norris": "fintual_cert_risky_norris",
  "import:fintual|cert|key=apv_a": "fintual_cert_apv_a",
  "import:fintual|cert|key=apv_b": "fintual_cert_apv_b",
};

export const FINTUAL_CERT_V2_TRACKED_NOTES = new Set(Object.keys(FINTUAL_CERT_V2_ACCOUNT_NAMES));

/** Leaf `asset_groups` for APV régimen — not `leafAssetGroupIdForKindSlug('apv')` (ties to apv-b). */
const FINTUAL_CERT_V2_APV_LEAF_ASSET_GROUP_SLUG: Partial<Record<string, string>> = {
  "import:fintual|cert|key=apv_a": "retirement_apv_a__apv",
  "import:fintual|cert|key=apv_b": "retirement_apv_b__apv",
};

export function assetGroupIdForFintualCertV2Notes(importNotes: string): number {
  const leafSlug = FINTUAL_CERT_V2_APV_LEAF_ASSET_GROUP_SLUG[importNotes];
  if (leafSlug) {
    const g = assetGroupBySlug(leafSlug);
    if (!g) throw new Error(`missing asset group ${leafSlug} for ${importNotes}`);
    return g.id;
  }
  const kind = FINTUAL_CERT_V2_CATEGORY_SLUG[importNotes];
  if (!kind) throw new Error(`Unknown Fintual cert v2 notes: ${importNotes}`);
  return assetGroupIdForImportKind(kind);
}

export const FINTUAL_CERT_MOVEMENT_NOTE_PREFIX = "import:fintual|cert|movement";

export function isFintualCertV2AccountNotes(notes: string | null | undefined): boolean {
  return typeof notes === "string" && notes.startsWith("import:fintual|cert|key=");
}

export function fintualCertV2SeriesKeyFromImportNotes(importNotes: string): string | null {
  return FINTUAL_CERT_V2_SERIES_KEY[importNotes] ?? null;
}

export function fintualCertV2GoalMapPath(): string {
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  return path.join(__dirname, "..", "data", "fintual-goal-map-v2.json");
}

export function loadFintualCertV2GoalIdOverrides(): Record<string, string> {
  const p = fintualCertV2GoalMapPath();
  if (!fs.existsSync(p)) return {};
  const j = JSON.parse(fs.readFileSync(p, "utf8")) as unknown;
  if (!j || typeof j !== "object") throw new Error(`fintual goal map is not a JSON object: ${p}`);
  const by = (j as { byGoalId?: unknown }).byGoalId;
  if (!by || typeof by !== "object") throw new Error(`fintual goal map missing byGoalId object: ${p}`);
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(by as Record<string, unknown>)) {
    if (typeof v !== "string" || !v.trim()) {
      throw new Error(`fintual goal map byGoalId["${k}"] must be a non-empty string: ${p}`);
    }
    out[String(k)] = v.trim();
  }
  return out;
}

/** Infer Fintual goal id from certificado investment name (CSV). */
export function fintualCertGoalIdFromInvestmentName(name: string): string | null {
  const n = name
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{M}/gu, "");
  if (n.includes("mega") && n.includes("cbcb")) return "78515";
  if (n.includes("mega") && n.includes("caca")) return "16749";
  if (n.includes("caca") && n.includes("daca")) return "2859";
  if (n.includes("reserva")) return "1164983";
  return null;
}

export function matchFintualCertGoalV2(goalId: string, investmentName: string): string | null {
  const overrides = loadFintualCertV2GoalIdOverrides();
  const ovr = overrides[goalId];
  if (ovr && FINTUAL_CERT_V2_TRACKED_NOTES.has(ovr)) return ovr;
  const mapped = FINTUAL_CERT_V2_GOAL_IDS[goalId];
  if (mapped) return mapped;
  const inferred = fintualCertGoalIdFromInvestmentName(investmentName);
  if (inferred) return FINTUAL_CERT_V2_GOAL_IDS[inferred] ?? null;
  return null;
}

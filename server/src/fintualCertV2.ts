/**
 * Fintual “certificado de transacciones” v2 accounts: cuotas in movements, valor cuota in fund_unit_daily.
 * Parallel to legacy `import:excel|key=…` accounts until manually removed.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assetGroupBySlug } from "./assetGroupTree.js";
import { assetGroupIdForImportKind } from "./portfolioGroupTree.js";
import { FINTUAL_GOALS, fintualGoalByImportKey, isFintualGoalImportKey, type FintualGoal } from "./fintualGoals.js";

const byKey = <T,>(f: (g: FintualGoal) => T): Record<string, T> =>
  Object.fromEntries(FINTUAL_GOALS.map((g) => [g.importKey, f(g)]));

/** Goal id → import key (`fintualGoals.ts` is the table). */
export const FINTUAL_CERT_V2_GOAL_IDS: Record<string, string> = Object.fromEntries(
  FINTUAL_GOALS.map((g) => [g.goalId, g.importKey])
);
export const FINTUAL_CERT_V2_ACCOUNT_NAMES: Record<string, string> = byKey((g) => g.name);
export const FINTUAL_CERT_V2_CATEGORY_SLUG: Record<string, string> = byKey((g) => g.categorySlug);
export const FINTUAL_CERT_V2_SERIES_KEY: Record<string, string> = byKey((g) => g.seriesKey);

export const FINTUAL_CERT_V2_TRACKED_NOTES = new Set(Object.keys(FINTUAL_CERT_V2_ACCOUNT_NAMES));

export function assetGroupIdForFintualCertV2Notes(importNotes: string): number {
  const leafSlug = fintualGoalByImportKey(importNotes)?.apvLeafSlug;
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
  return isFintualGoalImportKey(notes);
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

/**
 * Fintual “certificado de transacciones” v2 accounts: cuotas in movements, valor cuota in fund_unit_daily.
 * Parallel to the older `import:excel|key=…` accounts still in the database.
 */
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

/**
 * The certificado account key of a live Fintual goal, by the goal's id alone (`fintualGoals.ts`):
 * null for a goal the app does not track. The sync and valuation paths resolve goals only this
 * way — a goal's name is never evidence of which account it is.
 */
export function fintualCertGoalImportKeyById(goalId: string): string | null {
  return FINTUAL_CERT_V2_GOAL_IDS[String(goalId).trim()] ?? null;
}

/**
 * The tracked goals whose name rule an investment name meets (accents and case folded). The
 * certificado's name is the only clue for a row whose investment id no tracked goal carries.
 */
function goalIdsByInvestmentName(name: string): string[] {
  const n = name
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{M}/gu, "");
  const ids: string[] = [];
  if (n.includes("mega") && n.includes("cbcb")) ids.push("78515");
  if (n.includes("mega") && n.includes("caca")) ids.push("16749");
  if (n.includes("caca") && n.includes("daca")) ids.push("2859");
  if (n.includes("reserva")) ids.push("1164983");
  return ids;
}

/**
 * The account key of a certificado de transacciones row: by its investment id when a tracked
 * goal carries it, else by its name — the certificado is the one source whose rows may carry an
 * id no live goal has (it lists every investment ever held). A name that meets two goals' rules
 * throws; one that meets none is an investment the app does not track (null).
 */
export function matchFintualCertificadoInvestment(investmentId: string, investmentName: string): string | null {
  const byId = fintualCertGoalImportKeyById(investmentId);
  if (byId) return byId;
  const ids = goalIdsByInvestmentName(investmentName);
  if (ids.length > 1) {
    throw new Error(
      `Fintual certificado: investment ${investmentId} «${investmentName}» matches ${ids.length} tracked goals by name (${ids.join(", ")})`
    );
  }
  return ids.length === 1 ? (FINTUAL_CERT_V2_GOAL_IDS[ids[0]!] ?? null) : null;
}

/**
 * The vendor catalog (`vendor_catalog`, migration 248): how a name the bank, a receipt or a
 * transfer mail prints is shown. One entry per (kind, pattern):
 *
 *   - `exact`  — the folded name equals the pattern («COM.MANTENCION PLAN» → «Comisión mantención plan»)
 *   - `prefix` — the folded name starts with it («AMZN MKTP US*…» → «Amazon.com»)
 *   - `branch` — the folded name is the pattern, or the pattern + a space + a branch: the brand with
 *                the branch in parentheses («JUMBO BILBAO» → «Jumbo (Bilbao)»)
 *   - `rut`    — a transfer counterparty's RUT (digits + verifier, no dots or dash) → its name
 *
 * Patterns are stored folded (`foldVendorName`): upper case, no accents, single spaces. Generic
 * brands are seeded by the migration (`source = 'seed'`); the user's own entries — people, RUTs,
 * places — are personal data, loaded on the live DB from an untracked file
 * (`server/scripts/load-vendor-catalog.ts`, `source = 'user'`), and win over a seed entry of the
 * same pattern because they are matched first.
 *
 * Pure: no database access, so the migration hooks can match names while `db.ts` is loading;
 * `vendorCatalog.ts` adds the loaders.
 */
import { foldVendorName, stripLegalSuffix, titleCaseName } from "./expenseNameText.js";
import { placeBranch } from "./chilePlaces.js";

export { foldVendorName };

export type VendorCatalogKind = "exact" | "prefix" | "branch" | "rut";

/** `choice`: a branch the user picked on an expense row among the places a cut name could be. */
export type VendorCatalogSource = "seed" | "user" | "choice";

export type VendorCatalogEntry = {
  kind: VendorCatalogKind;
  pattern: string;
  display: string;
  source: VendorCatalogSource;
};

/** The statement's merchant column width; a name this long (spaces collapsed, a few less) may be cut. */
const STATEMENT_MERCHANT_WIDTH = 22;
const MAY_BE_CUT_FROM = STATEMENT_MERCHANT_WIDTH - 4;

/** «11.111.111-1» → «111111111»; «22.222.222-k» → «22222222K». */
export function normalizeRut(rut: string): string {
  return rut.replace(/[^0-9kK]/g, "").toUpperCase();
}

/**
 * A branch as the bank prints it, readable: store codes dropped («L272 LOS LEONES» → «Los Leones»),
 * a trailing dot dropped, places spelled out (`chilePlaces.ts`). A branch a receipt already sets
 * apart — «- Isidora», «(Isidora)» — is unwrapped first, so it is not wrapped twice. `cut`: the
 * printed name may have been cut, so a branch ending mid-word may complete to its place.
 */
function branchName(rest: string, cut: boolean): { text: string; choices: string[] | null } {
  const unwrapped = rest
    .trim()
    .replace(/^[-–]\s*/, "")
    .replace(/^\(([^()]*)\)$/, "$1")
    .replace(/\.+$/, "")
    .trim();
  const cleaned = unwrapped.replace(/^(?:[A-Z]?\d{2,}\s+)+/i, "").trim();
  // A «branch» that is only the brand's legal form («OK MARKET S.A.») is no branch.
  if (!cleaned || stripLegalSuffix(`_ ${cleaned}`) === "_") return { text: "", choices: null };
  return placeBranch(titleCaseName(cleaned), cut);
}

export type VendorCatalogMatch = {
  display: string;
  /** The vendor the display names, without a branch entry's branch («Jumbo» for «Jumbo (Bilbao)»). */
  brand: string;
  /** A branch the cut name leaves open: each full display name it could be, for the user to pick. */
  branchChoices: string[] | null;
};

export type VendorCatalog = {
  /** The display name for a printed name, or null when no entry matches. */
  lookup(name: string): string | null;
  /** `lookup` with the branches a cut name could be. */
  match(name: string): VendorCatalogMatch | null;
  /** The display name for a counterparty's RUT, or null. */
  lookupRut(rut: string | null): string | null;
};

const SOURCE_ORDER: Record<VendorCatalogSource, number> = { user: 0, choice: 1, seed: 2 };

export function vendorCatalogFromEntries(entries: readonly VendorCatalogEntry[]): VendorCatalog {
  // User entries first, then the user's branch picks, so both win over a seed entry of the same name.
  const ordered = [...entries].sort((a, b) => SOURCE_ORDER[a.source] - SOURCE_ORDER[b.source]);
  const exact = new Map<string, string>();
  const rut = new Map<string, string>();
  const prefixes: { pattern: string; display: string; branch: boolean }[] = [];
  for (const e of ordered) {
    if (e.kind === "exact") {
      if (!exact.has(e.pattern)) exact.set(e.pattern, e.display);
    } else if (e.kind === "rut") {
      if (!rut.has(e.pattern)) rut.set(e.pattern, e.display);
    } else prefixes.push({ pattern: e.pattern, display: e.display, branch: e.kind === "branch" });
  }
  // Longest pattern first; a stable sort keeps user entries ahead of seed ones of the same length.
  prefixes.sort((a, b) => b.pattern.length - a.pattern.length);
  const match = (name: string): VendorCatalogMatch | null => {
    const folded = foldVendorName(name);
    if (!folded) return null;
    const hit = exact.get(folded);
    if (hit != null) return { display: hit, brand: hit, branchChoices: null };
    for (const p of prefixes) {
      if (p.branch) {
        if (folded === p.pattern) return { display: p.display, brand: p.display, branchChoices: null };
        if (!folded.startsWith(`${p.pattern} `)) continue;
        // The branch keeps the printed text's own letters (accents included).
        const rest = branchName(
          name.trim().replace(/\s+/g, " ").slice(p.pattern.length + 1),
          folded.length >= MAY_BE_CUT_FROM
        );
        return {
          display: rest.text ? `${p.display} (${rest.text})` : p.display,
          brand: p.display,
          branchChoices: rest.choices ? rest.choices.map((c) => `${p.display} (${c})`) : null,
        };
      }
      if (folded.startsWith(p.pattern)) return { display: p.display, brand: p.display, branchChoices: null };
    }
    return null;
  };
  return {
    match,
    lookup(name) {
      return match(name)?.display ?? null;
    },
    lookupRut(r) {
      if (!r) return null;
      return rut.get(normalizeRut(r)) ?? null;
    },
  };
}


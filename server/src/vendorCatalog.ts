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
 */
import { db } from "./db.js";
import { titleCaseName } from "./expenseNameText.js";

export type VendorCatalogKind = "exact" | "prefix" | "branch" | "rut";

export type VendorCatalogEntry = {
  kind: VendorCatalogKind;
  pattern: string;
  display: string;
  source: "seed" | "user";
};

/** «Jumbo  Peñalolén» → «JUMBO PENALOLEN»: upper case, accents dropped, single spaces. */
export function foldVendorName(text: string): string {
  return text
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toUpperCase()
    .replace(/\s+/g, " ")
    .trim();
}

/** «11.111.111-1» → «111111111»; «22.222.222-k» → «22222222K». */
export function normalizeRut(rut: string): string {
  return rut.replace(/[^0-9kK]/g, "").toUpperCase();
}

/**
 * A branch as the bank prints it, readable: store codes dropped («L272 LOS LEONES» → «Los Leones»).
 * A branch a receipt already sets apart — «- Isidora», «(Isidora)» — is unwrapped first, so it is
 * not wrapped twice.
 */
function branchName(rest: string): string {
  const unwrapped = rest
    .trim()
    .replace(/^[-–]\s*/, "")
    .replace(/^\(([^()]*)\)$/, "$1")
    .trim();
  const cleaned = unwrapped.replace(/^(?:[A-Z]?\d{2,}\s+)+/i, "").trim();
  return cleaned ? titleCaseName(cleaned) : "";
}

export type VendorCatalog = {
  /** The display name for a printed name, or null when no entry matches. */
  lookup(name: string): string | null;
  /** The display name for a counterparty's RUT, or null. */
  lookupRut(rut: string | null): string | null;
};

export function vendorCatalogFromEntries(entries: readonly VendorCatalogEntry[]): VendorCatalog {
  // User entries first, so they win over a seed entry that matches the same name.
  const ordered = [...entries].sort((a, b) => (a.source === b.source ? 0 : a.source === "user" ? -1 : 1));
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
  return {
    lookup(name) {
      const folded = foldVendorName(name);
      if (!folded) return null;
      const hit = exact.get(folded);
      if (hit != null) return hit;
      for (const p of prefixes) {
        if (p.branch) {
          if (folded === p.pattern) return p.display;
          if (!folded.startsWith(`${p.pattern} `)) continue;
          // The branch keeps the printed text's own letters (accents included).
          const rest = branchName(name.trim().replace(/\s+/g, " ").slice(p.pattern.length + 1));
          return rest ? `${p.display} (${rest})` : p.display;
        }
        if (folded.startsWith(p.pattern)) return p.display;
      }
      return null;
    },
    lookupRut(r) {
      if (!r) return null;
      return rut.get(normalizeRut(r)) ?? null;
    },
  };
}

export function loadVendorCatalog(): VendorCatalog {
  const rows = db
    .prepare(`SELECT match_kind AS kind, pattern, display, source FROM vendor_catalog`)
    .all() as VendorCatalogEntry[];
  return vendorCatalogFromEntries(rows);
}

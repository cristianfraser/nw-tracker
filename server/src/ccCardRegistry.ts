import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Personal per-card configuration (real card last4s: consolidation redirects, superseded
 * masters, statement-classification tokens) lives OUTSIDE git in `cfraser/cc-cards.json` —
 * the repo must stay free of real card numbers. A missing file is a valid empty registry
 * (no personal cards configured: demo mode, CI, fresh clones). A present-but-malformed
 * file throws. Tests inject synthetic cards via `NW_TRACKER_CC_CARDS` (path to a JSON
 * file; set in `vitest.setup.ts` before src modules load).
 */
export type CcCardRegistry = {
  /** Predecessor/consolidated card last4 → successor master last4 (import routing). */
  import_redirect_last4: Readonly<Record<string, string>>;
  /** `accounts.notes` of superseded CC masters kept out of group totals. */
  superseded_master_notes: readonly string[];
  /** Statement-text tokens marking multi-card Santander layouts (e.g. `XXXX-<last4>`). */
  multicard_marker_tokens: readonly string[];
  /** Filename tokens for the legacy "group B" Santander parser body. */
  legacy_group_b_tokens: readonly string[];
  /** Card last4s appearing in BCI Lider statement filenames. */
  lider_filename_last4s: readonly string[];
  /** Cards whose statements skip reconcile (superseded). */
  reconcile_skip_last4s: readonly string[];
  /** Primary-import cards whose statements require reconcile. */
  reconcile_primary_last4s: readonly string[];
};

const EMPTY_REGISTRY: CcCardRegistry = {
  import_redirect_last4: {},
  superseded_master_notes: [],
  multicard_marker_tokens: [],
  legacy_group_b_tokens: [],
  lider_filename_last4s: [],
  reconcile_skip_last4s: [],
  reconcile_primary_last4s: [],
};

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function registryFilePath(): string {
  const override = process.env.NW_TRACKER_CC_CARDS?.trim();
  if (override) return path.resolve(override);
  return path.join(__dirname, "..", "..", "cfraser", "cc-cards.json");
}

let cached: CcCardRegistry | null = null;

export function ccCardRegistry(): CcCardRegistry {
  if (cached) return cached;
  const file = registryFilePath();
  if (!fs.existsSync(file)) {
    cached = EMPTY_REGISTRY;
    return cached;
  }
  const data = JSON.parse(fs.readFileSync(file, "utf-8")) as Record<string, unknown>;
  const unknown = Object.keys(data).filter((k) => !(k in EMPTY_REGISTRY));
  if (unknown.length > 0) {
    throw new Error(`${file}: unknown keys: ${unknown.join(", ")}`);
  }
  cached = { ...EMPTY_REGISTRY, ...(data as Partial<CcCardRegistry>) };
  return cached;
}

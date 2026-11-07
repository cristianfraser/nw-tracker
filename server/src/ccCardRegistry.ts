import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ccCardRegistrySchema, type CcCardRegistry } from "nw-tracker-contracts";

export type { CcCardRegistry };

/**
 * Personal per-card configuration (real card last4s: consolidation redirects, superseded
 * masters, statement-classification tokens) lives OUTSIDE git in `cfraser/cc-cards.json` —
 * the repo must stay free of real card numbers. A missing file is a valid empty registry
 * (no personal cards configured: demo mode, CI, fresh clones). A present file must satisfy the
 * shared schema (`ccCardRegistrySchema` in contracts, which the parser's `cc_cards.py` validates
 * against too); a malformed one throws. Read once, at first use — never at module load. Tests
 * inject synthetic cards via `NW_TRACKER_CC_CARDS` (path to a JSON file; set in
 * `vitest.setup.ts` before src modules load).
 */

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
  const data: unknown = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf-8")) : {};
  const parsed = ccCardRegistrySchema.safeParse(data);
  if (!parsed.success) {
    throw new Error(`${file}: ${parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ")}`);
  }
  cached = parsed.data;
  return cached;
}

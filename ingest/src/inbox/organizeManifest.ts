/**
 * The inbox organizer's manifest (`organize:inbox --manifest=…`): which PDFs it filed this run, so
 * the pipeline imports just those, and which it held (moved to `inbox/held/`: not ours), so the
 * pipeline reports them.
 */
import fs from "node:fs";
import path from "node:path";
import { resolveCfraserDir } from "../paths.js";

/** Why the organizer held a file (`HELD_*` in `organize-cfraser-statement-pdfs.py`). */
export const HELD_REASONS = {
  not_a_known_document: "readable, with no bank document word in it",
  cannot_decrypt: "no configured statement password opens it",
  unrecognised_bank_document: "is not a statement or cartola the organizer recognises",
} as const;

export type HeldReason = keyof typeof HELD_REASONS;

/**
 * `file`: its inbox name; `held_as`: where it went, under `cfraser/` (a clash there keeps both);
 * `hint`: what to do, when there is something (which variables hold the statement passwords);
 * `word`: the bank word an `unrecognised_bank_document` prints.
 */
export type HeldInboxFile = { file: string; held_as: string; reason: HeldReason; hint?: string; word?: string };

export type CfraserOrganizeManifest = {
  cuenta_vista_pdfs: string[];
  checking_pdfs: string[];
  credit_card_pdfs: string[];
  held: HeldInboxFile[];
};

export function resolveCfraserOrganizeManifestPath(): string {
  return path.join(resolveCfraserDir(), "inbox-organize-manifest.json");
}

export function emptyCfraserOrganizeManifest(): CfraserOrganizeManifest {
  return { cuenta_vista_pdfs: [], checking_pdfs: [], credit_card_pdfs: [], held: [] };
}

function heldEntry(raw: unknown): HeldInboxFile {
  const e = raw as Partial<HeldInboxFile> | null;
  if (
    !e ||
    typeof e.file !== "string" ||
    typeof e.held_as !== "string" ||
    !e.reason ||
    !(e.reason in HELD_REASONS) ||
    (e.hint !== undefined && typeof e.hint !== "string") ||
    (e.reason === "unrecognised_bank_document" ? typeof e.word !== "string" || e.word === "" : e.word !== undefined)
  ) {
    throw new Error(`inbox manifest: not a held file: ${JSON.stringify(raw)}`);
  }
  return { file: e.file, held_as: e.held_as, reason: e.reason, ...(e.hint ? { hint: e.hint } : {}), ...(e.word ? { word: e.word } : {}) };
}

export function loadCfraserOrganizeManifest(
  manifestPath = resolveCfraserOrganizeManifestPath()
): CfraserOrganizeManifest {
  if (!fs.existsSync(manifestPath)) return emptyCfraserOrganizeManifest();
  const raw = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as Partial<Record<keyof CfraserOrganizeManifest, unknown[]>>;
  return {
    cuenta_vista_pdfs: [...((raw.cuenta_vista_pdfs as string[] | undefined) ?? [])],
    checking_pdfs: [...((raw.checking_pdfs as string[] | undefined) ?? [])],
    credit_card_pdfs: [...((raw.credit_card_pdfs as string[] | undefined) ?? [])],
    held: (raw.held ?? []).map(heldEntry),
  };
}

/**
 * One notice per held file, for the pipeline's step result: the run message lists them under the
 * step, and a run with a notice is a notification, so a held file is seen once and never fails a run.
 */
export function heldFileNotices(held: readonly HeldInboxFile[], opts: { dryRun?: boolean } = {}): string[] {
  return held.map((h) => {
    const verb = opts.dryRun ? "Would hold" : "Held";
    const where = path.posix.dirname(h.held_as.split(path.sep).join("/"));
    const keptIn = `kept in cfraser/${where}/${path.basename(h.held_as) === h.file ? "" : ` as ${path.basename(h.held_as)}`}`;
    if (h.reason === "unrecognised_bank_document") {
      // Something to look at: a statement in a layout the parser does not know lands here.
      return `${verb}, not imported: ${h.file} — prints «${h.word}» but ${HELD_REASONS[h.reason]}; if it is one, the parser needs to learn its layout (${keptIn})`;
    }
    // A password problem is the one held file the user can fix: say how, and how to retry.
    const todo =
      h.reason === "cannot_decrypt"
        ? ` — ${h.hint ?? "set the statement password"} in the root .env, then move it back to cfraser/inbox/ to retry`
        : "";
    return `${verb}, not imported: ${h.file} — ${HELD_REASONS[h.reason]}; ${keptIn}${todo}`;
  });
}

/** `cartolas-cuenta-vista/foo.pdf` → `foo.pdf` */
export function basenameFromCfraserOrganizePath(relPath: string): string {
  return path.basename(relPath);
}

export function basenamesFromCfraserOrganizePaths(relPaths: string[]): string[] {
  return relPaths.map(basenameFromCfraserOrganizePath);
}

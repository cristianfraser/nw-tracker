import fs from "node:fs";
import path from "node:path";
import type { BankAccountStatementsApplyDetails } from "nw-tracker-contracts";
import { resolveCfraserDir } from "../paths.js";

/**
 * Cartolas the server refused or could not read stay pending until they import or a person files
 * them away: the inbox pipeline sends only the documents it filed in its own run (organize has
 * moved them out of the inbox), so a refused cartola would otherwise be reported once and its month
 * stay missing in silence. The pending list lives in `cfraser/.cartola-pending.json`, one list per
 * account; every pipeline run sends the pending documents again with its own
 * (`checkingCartolaStepArgs`, `inbox/cartolaSteps.ts`) and `import:checking-cartolas` /
 * `import:cuenta-vista-cartolas` rewrite the list from the server's answer
 * (`nextPendingCartolas`): a document answered `refused` or `parse_error` stays (its problems
 * reported again), one imported, confirmed or already on file leaves, and one asked for that no
 * reader found (filed away, deleted) leaves with a notice.
 */

export type CartolaAccountKey = "checking" | "cuenta-vista";

export type PendingCartola = {
  document: string;
  /** When it first stayed pending (ISO instant). */
  since: string;
  /** The server's status for it last time (`refused` | `parse_error`). */
  status: string;
  problems: string[];
};

type PendingState = Partial<Record<CartolaAccountKey, PendingCartola[]>>;

export function cartolaPendingPath(): string {
  return path.join(resolveCfraserDir(), ".cartola-pending.json");
}

function readState(file: string): PendingState {
  if (!fs.existsSync(file)) return {};
  const raw = fs.readFileSync(file, "utf8").trim();
  return raw ? (JSON.parse(raw) as PendingState) : {};
}

export function readPendingCartolas(account: CartolaAccountKey, file = cartolaPendingPath()): PendingCartola[] {
  return readState(file)[account] ?? [];
}

export function writePendingCartolas(account: CartolaAccountKey, pending: PendingCartola[], file = cartolaPendingPath()): void {
  const state = readState(file);
  if (pending.length > 0) state[account] = pending;
  else delete state[account];
  fs.writeFileSync(file, `${JSON.stringify(state, null, 2)}\n`);
}

/** The document a server file log names: `pdf:<name>`, a cuenta vista slice `pdf:<name>|<month>`. */
export function documentOfFileLog(label: string): string {
  return label.replace(/^pdf:/, "").replace(/\|\d{4}-\d{2}$/, "");
}

/** A real document name (a reader failure is logged under a bare tag such as `pdf`). */
function isDocumentName(name: string): boolean {
  return /\.(pdf|xlsx)$/i.test(name);
}

export type PendingUpdate = {
  pending: PendingCartola[];
  /** Pending documents that imported (or were found on file) this run. */
  resolved: string[];
  /** Pending documents asked for that no reader found: no longer on disk. */
  dropped: string[];
};

const STAYS = new Set(["refused", "parse_error"]);

/**
 * The pending list after a run: `asked` = whether the run asked for a document (its `--only-…`
 * list, or every document of a format read in full), `files` = the server's answer. A run whose
 * PDF reader failed as a whole drops nothing.
 */
export function nextPendingCartolas(
  previous: readonly PendingCartola[],
  asked: (document: string) => boolean,
  files: BankAccountStatementsApplyDetails["files"],
  now: string
): PendingUpdate {
  const byDocument = new Map<string, BankAccountStatementsApplyDetails["files"]>();
  for (const f of files) {
    const doc = documentOfFileLog(f.file);
    byDocument.set(doc, [...(byDocument.get(doc) ?? []), f]);
  }
  const readerFailed = files.some((f) => f.status === "parse_error" && !isDocumentName(documentOfFileLog(f.file)));
  const prior = new Map(previous.map((p) => [p.document, p]));
  const pending: PendingCartola[] = [];
  const resolved: string[] = [];
  const dropped: string[] = [];
  for (const [doc, logs] of byDocument) {
    if (!isDocumentName(doc)) continue;
    const bad = logs.filter((f) => STAYS.has(f.status));
    if (bad.length > 0) {
      pending.push({
        document: doc,
        since: prior.get(doc)?.since ?? now,
        status: bad[0]!.status,
        problems: bad.flatMap((f) => (f.problems.length > 0 ? f.problems : [f.error ?? f.status])),
      });
    } else if (prior.has(doc)) {
      resolved.push(doc);
    }
  }
  for (const p of previous) {
    if (byDocument.has(p.document)) continue;
    if (asked(p.document) && !readerFailed) dropped.push(p.document);
    else pending.push(p);
  }
  return { pending, resolved, dropped };
}

/**
 * The staged grocery receipt corpus and its import stamps. Two staging roots, nothing inferred
 * from file names:
 *  - `cfraser/lider-boletas/staged/<date>-<msgid>/` — the Lider «Boleta Digital» e-mail fetcher's
 *    output (Boleta.pdf + the mail's meta.json + parsed.json). Document kind `email`, chain
 *    `lider` by construction (only that fetcher writes there), key = the mail's message id.
 *  - `cfraser/grocery-receipts/staged/<date>-<source>-<key>/` — the chain-agnostic root (photos of
 *    paper receipts, hand-saved PDFs; see `inbox.ts`): meta.json carries `{source, source_key}`
 *    and parsed.json the parser's `chain` slug; a missing or unknown value throws.
 *
 * Each receipt goes to the server as one `store.receipt`. A final outcome is STAMPED in the dir
 * (`imported.json`: stamp version + sha256 of the parsed.json it sent + the receipt it landed on),
 * and a dir whose stamp is current is not sent again — the staged dirs are the permanent corpus.
 * An outcome that can still change (a receipt waiting for its card line) is not stamped, so it is
 * sent every run until it settles. `--full` ignores stamps (after a wiped database).
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { StoreReceiptApplyDetails, StoreReceiptDocumentKind, StoreReceiptPayload } from "nw-tracker-contracts";
import { resolveCfraserDir } from "../paths.js";

export const GROCERY_CHAIN_LIDER = "lider";

/** The generic root's meta.json `source` values (the e-mail root is always `email`). */
export const GENERIC_STAGED_SOURCES = ["pdf", "photo"] as const;
export type GenericStagedSource = (typeof GENERIC_STAGED_SOURCES)[number];

export function liderBoletasStagedDir(cfraserDir = resolveCfraserDir()): string {
  return path.join(cfraserDir, "lider-boletas", "staged");
}

export function groceryReceiptsStagedDir(cfraserDir = resolveCfraserDir()): string {
  return path.join(cfraserDir, "grocery-receipts", "staged");
}

/** `lider_email`: the e-mail fetcher's layout. `generic`: meta.json names the source, parsed.json the chain. */
export type StagingRoot = { kind: "lider_email" | "generic"; dir: string };

export function defaultStagingRoots(cfraserDir = resolveCfraserDir()): StagingRoot[] {
  return [
    { kind: "lider_email", dir: liderBoletasStagedDir(cfraserDir) },
    { kind: "generic", dir: groceryReceiptsStagedDir(cfraserDir) },
  ];
}

/** meta.json of the generic root — written by `inbox.ts`, never inferred. */
export type GenericStagedMeta = {
  source: GenericStagedSource;
  source_key: string;
  original_file?: string;
  original_name?: string;
  ingested_at?: string;
  /** `YYYY-MM-DD` from a photo named `YYYY:MM:DD.<ext>` (`photoTakenOnFromName`). */
  photo_taken_on?: string;
};

/** parsed.json as `parse-grocery-receipts.py` writes it (`grocery_receipt_model.py`). */
export type ParsedReceipt = {
  /** The parser's chain slug — required in the generic root (the e-mail root is Lider by construction). */
  chain?: string;
  boleta_number: string | null;
  caja: string;
  sucursal: string;
  city: string | null;
  purchased_at: string | null;
  purchase_date_source?: "printed" | "declared" | null;
  template: string;
  items: {
    position: number;
    barcode: string | null;
    description: string;
    qty: string;
    qty_unit: "un" | "kg";
    unit_price_clp: number;
    total_clp: number;
    discount_clp: number;
    discount_labels: string[];
  }[];
  receipt_discounts?: { label: string; amount_clp: number }[];
  payments: { method: string; amount_clp: number }[];
  total_printed_clp: number | null;
  articles_declared: number | null;
  mi_club_points: number | null;
  parser_version: number;
};

/** Bump to send every staged receipt again (a change to what is sent). */
export const IMPORT_STAMP_VERSION = 1;

export type ImportStamp = {
  import_version: number;
  parsed_sha256: string;
  receipt_key: string;
  receipt_id: number;
  receipt_status: string;
  movement_status: string;
  imported_at: string;
};

export type StagedReceipt = {
  root: StagingRoot["kind"];
  /** The staged dir's name (what the log prints). */
  dir: string;
  /** Absolute path of the staged dir (stamps are written here). */
  path: string;
  document: StoreReceiptDocumentKind;
  key: string;
  chain: string;
  parsed: ParsedReceipt;
  parsed_sha256: string;
  stamp: ImportStamp | null;
  photo_taken_on: string | null;
};

function sha256(buf: Buffer): string {
  return crypto.createHash("sha256").update(buf).digest("hex");
}

function readStamp(dir: string): ImportStamp | null {
  const file = path.join(dir, "imported.json");
  if (!fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as ImportStamp;
  } catch {
    return null; // an unreadable stamp is no stamp: the receipt is simply sent again
  }
}

function isGenericSource(v: unknown): v is GenericStagedSource {
  return typeof v === "string" && (GENERIC_STAGED_SOURCES as readonly string[]).includes(v);
}

/** The file that marks a staged dir as holding a receipt document (the parser has not necessarily run). */
function stagedDocumentPresent(root: StagingRoot, dir: string): boolean {
  return root.kind === "lider_email" ? fs.existsSync(path.join(dir, "Boleta.pdf")) : fs.existsSync(path.join(dir, "meta.json"));
}

export function stampIsCurrent(staged: StagedReceipt): boolean {
  const s = staged.stamp;
  return s != null && s.import_version === IMPORT_STAMP_VERSION && s.parsed_sha256 === staged.parsed_sha256;
}

/** Anything still to do: a staged document with no parse yet, or a parse without a current stamp. */
export function hasPendingGroceryReceipts(roots = defaultStagingRoots()): boolean {
  return roots.some((root) => {
    if (!fs.existsSync(root.dir)) return false;
    return fs.readdirSync(root.dir).some((name) => {
      const dir = path.join(root.dir, name);
      if (!stagedDocumentPresent(root, dir)) return false;
      const parsedFile = path.join(dir, "parsed.json");
      if (!fs.existsSync(parsedFile)) return true;
      const stamp = readStamp(dir);
      return !(stamp && stamp.import_version === IMPORT_STAMP_VERSION && stamp.parsed_sha256 === sha256(fs.readFileSync(parsedFile)));
    });
  });
}

/** Staged dirs that have BOTH meta.json and parsed.json (run the parser first), across all roots. */
export function listStagedReceipts(roots = defaultStagingRoots()): StagedReceipt[] {
  const out: StagedReceipt[] = [];
  for (const root of roots) {
    if (!fs.existsSync(root.dir)) continue;
    for (const name of fs.readdirSync(root.dir).sort()) {
      const dir = path.join(root.dir, name);
      const metaFile = path.join(dir, "meta.json");
      const parsedFile = path.join(dir, "parsed.json");
      if (!fs.existsSync(metaFile) || !fs.existsSync(parsedFile)) continue;
      const parsedBytes = fs.readFileSync(parsedFile);
      const parsed = JSON.parse(parsedBytes.toString("utf8")) as ParsedReceipt;
      const meta = JSON.parse(fs.readFileSync(metaFile, "utf8")) as Record<string, unknown>;
      const common = { root: root.kind, dir: name, path: dir, parsed, parsed_sha256: sha256(parsedBytes), stamp: readStamp(dir) };
      if (root.kind === "lider_email") {
        if (typeof meta.message_id !== "string" || !meta.message_id) throw new Error(`${dir}: lider_email meta.json without message_id`);
        if (parsed.chain != null && parsed.chain !== GROCERY_CHAIN_LIDER) {
          throw new Error(`${dir}: the Lider e-mail root holds a receipt the parser attributes to chain ${JSON.stringify(parsed.chain)}`);
        }
        out.push({ ...common, document: "email", key: meta.message_id, chain: GROCERY_CHAIN_LIDER, photo_taken_on: null });
      } else {
        if (!isGenericSource(meta.source)) {
          throw new Error(`${dir}: meta.json source must be one of ${GENERIC_STAGED_SOURCES.join("/")}, got ${JSON.stringify(meta.source)}`);
        }
        if (typeof meta.source_key !== "string" || !meta.source_key) throw new Error(`${dir}: meta.json without source_key`);
        if (!parsed.chain) throw new Error(`${dir}: parsed.json without chain — the generic root requires the parser's chain slug`);
        out.push({
          ...common,
          document: meta.source,
          key: meta.source_key,
          chain: parsed.chain,
          photo_taken_on: typeof meta.photo_taken_on === "string" ? meta.photo_taken_on : null,
        });
      }
    }
  }
  return out;
}

/** The `store.receipt` payload for one staged receipt. */
export function storeReceiptPayload(staged: StagedReceipt, apply: boolean): StoreReceiptPayload {
  const p = staged.parsed;
  return {
    apply,
    document: { kind: staged.document, key: staged.key, photo_taken_on: staged.photo_taken_on },
    receipt: {
      chain: staged.chain,
      number: p.boleta_number,
      branch: p.sucursal,
      city: p.city,
      purchased_at: p.purchased_at,
      purchase_date_source: p.purchased_at == null ? null : (p.purchase_date_source ?? "printed"),
      items: p.items.map((i) => ({
        position: i.position,
        barcode: i.barcode,
        description: i.description,
        qty: i.qty,
        qty_unit: i.qty_unit,
        unit_price: i.unit_price_clp,
        total: i.total_clp,
        discount: i.discount_clp,
        discount_labels: i.discount_labels,
      })),
      receipt_discounts: (p.receipt_discounts ?? []).map((d) => ({ label: d.label, amount: d.amount_clp })),
      payments: p.payments.map((x) => ({ method: x.method, amount: x.amount_clp })),
      loyalty_points: p.mi_club_points,
    },
  };
}

export function writeStamp(staged: StagedReceipt, details: StoreReceiptApplyDetails, now = new Date()): void {
  const stamp: ImportStamp = {
    import_version: IMPORT_STAMP_VERSION,
    parsed_sha256: staged.parsed_sha256,
    receipt_key: details.receipt_key,
    receipt_id: details.receipt_id,
    receipt_status: details.receipt_status,
    movement_status: details.movement.status,
    imported_at: now.toISOString(),
  };
  fs.writeFileSync(path.join(staged.path, "imported.json"), JSON.stringify(stamp, null, 1) + "\n");
  staged.stamp = stamp;
}

/**
 * Remove the stamps of OTHER staged documents of a receipt a higher-ranked document just took
 * over: their stamp says they own it, so they are sent once more and stamped `skipped_duplicate`.
 * Returns the dirs whose stamp was removed.
 */
export function clearDisplacedStamps(all: readonly StagedReceipt[], winner: StagedReceipt, receiptKey: string): string[] {
  const cleared: string[] = [];
  for (const s of all) {
    if (s.path === winner.path || s.stamp?.receipt_key !== receiptKey || s.stamp.receipt_status === "skipped_duplicate") continue;
    fs.rmSync(path.join(s.path, "imported.json"), { force: true });
    s.stamp = null;
    cleared.push(s.dir);
  }
  return cleared;
}

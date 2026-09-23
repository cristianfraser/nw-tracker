/**
 * Grocery receipts import: staged receipt documents → grocery tables + open-month card lines.
 *
 * Two staging roots feed it (`defaultStagingRoots`), nothing is inferred from filenames:
 *  - `cfraser/lider-boletas/staged/<date>-<msgid>/` — the Lider «Boleta Digital» e-mail fetcher's
 *    output (Boleta.pdf + the e-mail's meta.json + parsed.json). Source `lider_email`, chain
 *    `lider` by construction (only that fetcher writes there), source_key = message id.
 *  - `cfraser/grocery-receipts/staged/<date>-<source>-<key>/` — the chain-agnostic root (photos of
 *    paper receipts, future chains): meta.json carries `{source, source_key}` explicitly and
 *    parsed.json carries the parser's `chain` slug; a missing or unknown value throws.
 *
 * Import is INCREMENTAL: a successful import stamps the staged dir (`imported.json`: stamp
 * version + sha256 of the parsed.json it imported + the row it landed on), and a dir whose
 * stamp is current is skipped (`receipt_status: "unchanged"`) — the staged dirs are the
 * permanent corpus, so without the stamp every run re-upserted all of it. A movement outcome
 * that can still change is NOT stamped (`pending_branch`: the receipt waits for the bank's own
 * line — see `groceryBranchLearning.ts` — and re-checks every run until it is paired or the
 * branch is declared); `--full` ignores stamps.
 *
 * Three outcomes per staged receipt:
 *
 *  1. IDENTITY. A receipt's natural identity is `receipt_key` = chain|receipt_number|date
 *     (migration 178); `source` / `source_key` are provenance of the document that owns the row.
 *     The same boleta can arrive as an e-mail AND as a photo of the paper copy, so the two must
 *     collapse onto one row: a higher-ranked document (e-mail > photo) REPLACES the owner, a
 *     lower- or equal-ranked one arriving second is SKIPPED (reported, never written — equal
 *     rank is "first writer wins", which keeps two photos of one receipt from ping-ponging the
 *     row between their source keys on every run). A document whose own identity now resolves
 *     to a receipt another document owns throws: a parser change moved an identity, which must
 *     surface rather than be reconciled by guess.
 *
 *  2. ALWAYS for the owner (idempotent, full history): the receipt + items land in
 *     `grocery_receipts` / `grocery_receipt_items` with provenance frozen (chain, branch, city,
 *     printed local datetime, payment legs). Items resolve to canonical products through
 *     `grocery_product_aliases` (barcode first, printed description second — chain-scoped) and
 *     STAMP the resolution; re-imports upsert by (receipt, position) and preserve stamps unless
 *     the printed description itself changed (a parser fix that renames a line sends it back to
 *     unclassified — re-matching an old rule against new text would be silent misclassification).
 *
 *  3. Card movement, per-chain rule (`CHAIN_CARD_RULES`): only for a chain whose co-branded card
 *     has no other feed carrying the purchase (Lider/BCI — the CSV scrape retired 2026-08-07), and
 *     only when BOTH hold: the receipt was paid with that card's payment leg (cash/TBK/other-card
 *     receipts store items only), AND the purchase date is inside the account's open facturación
 *     (closed months are statement-covered; a movement there would be noise the PDF supersedes).
 *     The line goes through the web-paste path on the registry-resolved master with the bank's
 *     exact merchant string for the branch (`boleta_sucursal_merchants` — the paper and e-mail
 *     renderings of one branch print different strings, so each rendering is its own registry
 *     key — plus the LEARNED map in `grocery_branch_merchants`), so dedupe collides head-on with
 *     the feed/statement rendering; the same-day+amount guard covers a differently-named twin.
 *     A branch neither map names is never guessed: the receipt is FLAGGED (`card_line_status =
 *     'pending_branch'`, no line written, the step does not fail) and the bank's own line for the
 *     same day and pesos — paste, feed or statement PDF — pairs with it and teaches the mapping
 *     (`groceryBranchLearning.ts`, hooked into the shared card-write funnel). Chains without a
 *     rule (a future Jumbo: its Santander card line already arrives with the nightly feed) are
 *     items-only.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { ccCardRegistry } from "./ccCardRegistry.js";
import {
  learnBranchForPendingReceipt,
  markReceiptCardLine,
  receiptCardLineRawLinePrefix,
  receiptCardLineStatus,
  resolveBranchMerchant,
  type PendingBranchReceipt,
} from "./groceryBranchLearning.js";
import { lastPdfBillingMonthForAccount, periodToIsoForBillingMonth } from "./ccManualBillingMonth.js";
import { importCcWebPasteLines } from "./accountImports.js";
import type { CcWebPasteLine } from "./ccWebPasteParse.js";
import type { ImportBatchKind } from "./importBatches.js";
import { classifyLiderLines, liderMasterAccountId } from "./liderMovementsImport.js";
import { resolveCfraserCsvDir } from "./cfraserPaths.js";
import { db } from "./db.js";

export const GROCERY_CHAIN_LIDER = "lider";

/**
 * `lider_email`: the fetched «Boleta Digital» PDF. `manual_pdf`: a receipt PDF dropped in the
 * generic inbox by hand (the same bank-grade document, so the same rank — equal rank is first
 * writer wins). `photo`: OCR of a paper receipt.
 */
export const GROCERY_RECEIPT_SOURCES = ["lider_email", "manual_pdf", "photo"] as const;
export type GroceryReceiptSource = (typeof GROCERY_RECEIPT_SOURCES)[number];
/** Which document owns a receipt when two describe it: a PDF over an OCR'd photo. */
const SOURCE_RANK: Readonly<Record<GroceryReceiptSource, number>> = { lider_email: 2, manual_pdf: 2, photo: 1 };

function isGroceryReceiptSource(v: unknown): v is GroceryReceiptSource {
  return typeof v === "string" && (GROCERY_RECEIPT_SOURCES as readonly string[]).includes(v);
}

// ---------------------------------------------------------------------------------------------
// Staging roots
// ---------------------------------------------------------------------------------------------

export function liderBoletasStagedDir(cfraserDir = resolveCfraserCsvDir()): string {
  return path.join(cfraserDir, "lider-boletas", "staged");
}

export function groceryReceiptsStagedDir(cfraserDir = resolveCfraserCsvDir()): string {
  return path.join(cfraserDir, "grocery-receipts", "staged");
}

/**
 * `lider_email`: the e-mail fetcher's layout (Boleta.pdf + e-mail meta). `generic`: meta.json
 * names `{source, source_key}` and parsed.json names the chain.
 */
export type StagingRoot = { kind: "lider_email" | "generic"; dir: string };

export function defaultStagingRoots(cfraserDir = resolveCfraserCsvDir()): StagingRoot[] {
  return [
    { kind: "lider_email", dir: liderBoletasStagedDir(cfraserDir) },
    { kind: "generic", dir: groceryReceiptsStagedDir(cfraserDir) },
  ];
}

/** The file that marks a staged dir as holding a receipt document (parsing happens in the import step). */
function stagedDocumentPresent(root: StagingRoot, dir: string): boolean {
  return root.kind === "lider_email"
    ? fs.existsSync(path.join(dir, "Boleta.pdf"))
    : fs.existsSync(path.join(dir, "meta.json"));
}

/**
 * The inbox-pipeline gate: anything still to do — a staged document with no parse yet, or a
 * parse without a current import stamp. (The generic inbox itself is checked by the caller,
 * `listGroceryReceiptInboxFiles`; this function is filesystem-only, no DB.)
 */
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

// ---------------------------------------------------------------------------------------------
// Import stamps
// ---------------------------------------------------------------------------------------------

/** Bump to force every staged dir through the importer again (a write-side change). */
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

function sha256(buf: Buffer): string {
  return crypto.createHash("sha256").update(buf).digest("hex");
}

function readStamp(dir: string): ImportStamp | null {
  const file = path.join(dir, "imported.json");
  if (!fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as ImportStamp;
  } catch {
    return null; // unreadable stamp = no stamp: the dir simply re-imports
  }
}

/** A movement outcome that no later run could change; only these get stamped. */
export function movementIsTerminal(status: GroceryReceiptImportResult["movement"]["status"]): boolean {
  return status !== "pending_branch";
}

type LiderEmailMeta = { message_id: string; subject: string; date: string; body_text: string };

/** meta.json contract of the generic root — written by the ingest step, never inferred. */
export type GenericStagedMeta = {
  source: GroceryReceiptSource;
  source_key: string;
  original_file?: string;
  original_name?: string;
  ingested_at?: string;
};

type ParsedReceiptItem = {
  position: number;
  barcode: string | null;
  description: string;
  qty: string;
  qty_unit: "un" | "kg";
  unit_price_clp: number;
  total_clp: number;
  discount_clp: number;
  discount_labels: string[];
};

export type ParsedReceipt = {
  /** Chain slug emitted by the parser — required in the generic root (the lider_email root is Lider by construction). */
  chain?: string;
  boleta_number: string;
  caja: string;
  sucursal: string;
  city: string | null;
  purchased_at: string;
  template: string;
  items: ParsedReceiptItem[];
  /** Receipt-scope rebates (Mi Club canje, whole-receipt coupons) — never product info. */
  receipt_discounts?: { label: string; amount_clp: number }[];
  payments: { method: string; amount_clp: number }[];
  total_printed_clp: number | null;
  articles_declared: number | null;
  mi_club_points: number | null;
  parser_version: number;
};

export type StagedReceipt = {
  root: StagingRoot["kind"];
  dir: string;
  /** Absolute path of the staged dir (stamps are written here). */
  path: string;
  source: GroceryReceiptSource;
  source_key: string;
  chain: string;
  parsed: ParsedReceipt;
  parsed_sha256: string;
  stamp: ImportStamp | null;
};

function readJson<T>(file: string): T {
  return JSON.parse(fs.readFileSync(file, "utf8")) as T;
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
      const common = { dir: name, path: dir, parsed, parsed_sha256: sha256(parsedBytes), stamp: readStamp(dir) };
      if (root.kind === "lider_email") {
        const meta = readJson<Partial<LiderEmailMeta>>(metaFile);
        if (!meta.message_id) throw new Error(`${dir}: lider_email meta.json without message_id`);
        if (parsed.chain != null && parsed.chain !== GROCERY_CHAIN_LIDER) {
          throw new Error(`${dir}: the Lider e-mail root holds a receipt the parser attributes to chain ${JSON.stringify(parsed.chain)}`);
        }
        out.push({ root: root.kind, ...common, source: "lider_email", source_key: meta.message_id, chain: GROCERY_CHAIN_LIDER });
      } else {
        const meta = readJson<Partial<GenericStagedMeta>>(metaFile);
        if (!isGroceryReceiptSource(meta.source)) {
          throw new Error(
            `${dir}: meta.json source must be one of ${GROCERY_RECEIPT_SOURCES.join("/")}, got ${JSON.stringify(meta.source)}`
          );
        }
        if (!meta.source_key) throw new Error(`${dir}: meta.json without source_key`);
        if (!parsed.chain) {
          throw new Error(`${dir}: parsed.json without chain — the generic root requires the parser's chain slug`);
        }
        out.push({ root: root.kind, ...common, source: meta.source, source_key: meta.source_key, chain: parsed.chain });
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Identity
// ---------------------------------------------------------------------------------------------

/**
 * Natural receipt identity, `<chain>|<receipt_number>|<YYYY-MM-DD>` — the same formula
 * migration 178 backfilled (`groceryReceiptKey178.ts`); keep the two in step.
 */
export function groceryReceiptKey(chain: string, receiptNumber: string, purchasedAt: string): string {
  const day = purchasedAt.slice(0, 10);
  if (!chain || !receiptNumber || !/^\d{4}-\d{2}-\d{2}$/.test(day)) {
    throw new Error(
      `grocery receipt key needs chain, receipt number and a 'YYYY-MM-DD …' purchase datetime, got ${JSON.stringify({ chain, receiptNumber, purchasedAt })}`
    );
  }
  return `${chain}|${receiptNumber}|${day}`;
}

export type ReceiptResolution =
  | { action: "insert" }
  /** This document already owns the row (re-import, or its identity re-derived onto a free key). */
  | { action: "update"; id: number }
  /** A higher-ranked document takes the row over from `displaced`. */
  | { action: "replace"; id: number; displaced: GroceryReceiptSource }
  /** A lower- or equal-ranked document arrived second: nothing is written. */
  | { action: "skip"; id: number; owner: GroceryReceiptSource };

const selectByKey = db.prepare(
  `SELECT id, source, source_key FROM grocery_receipts WHERE receipt_key = ?`
);
const selectBySourceKey = db.prepare(`SELECT id, receipt_key FROM grocery_receipts WHERE source_key = ?`);

export function resolveReceiptOwnership(staged: StagedReceipt): {
  receiptKey: string;
  resolution: ReceiptResolution;
} {
  const receiptKey = groceryReceiptKey(staged.chain, staged.parsed.boleta_number, staged.parsed.purchased_at);
  const bySource = selectBySourceKey.get(staged.source_key) as { id: number; receipt_key: string } | undefined;
  const byKey = selectByKey.get(receiptKey) as { id: number; source: string; source_key: string } | undefined;
  if (bySource) {
    if (byKey && byKey.id !== bySource.id) {
      throw new Error(
        `${staged.dir}: document ${staged.source}:${staged.source_key} now resolves to receipt ${receiptKey}, owned by ` +
          `${byKey.source}:${byKey.source_key} (row ${byKey.id}), while this document owns row ${bySource.id} ` +
          `(${bySource.receipt_key}) — a parser change moved a receipt identity; resolve by hand`
      );
    }
    return { receiptKey, resolution: { action: "update", id: bySource.id } };
  }
  if (byKey) {
    if (!isGroceryReceiptSource(byKey.source)) {
      throw new Error(`receipt ${receiptKey} (row ${byKey.id}) carries unknown source ${JSON.stringify(byKey.source)}`);
    }
    return SOURCE_RANK[staged.source] > SOURCE_RANK[byKey.source]
      ? { receiptKey, resolution: { action: "replace", id: byKey.id, displaced: byKey.source } }
      : { receiptKey, resolution: { action: "skip", id: byKey.id, owner: byKey.source } };
  }
  return { receiptKey, resolution: { action: "insert" } };
}

// ---------------------------------------------------------------------------------------------
// Per-chain card-movement rules
// ---------------------------------------------------------------------------------------------

type ChainCardRule = {
  /** The parsed payment method that is the chain's co-branded card — the only leg that becomes a card line. */
  payment_method: string;
  batch_kind: ImportBatchKind;
  master_account_id: () => number;
  /** Printed branch string (every rendering of it) → the bank's exact merchant string. */
  branch_merchants: () => Readonly<Record<string, string>>;
  classify: (accountId: number, lines: readonly CcWebPasteLine[]) => { importable: CcWebPasteLine[] };
  raw_line_prefix: string;
};

const CHAIN_CARD_RULES: Readonly<Record<string, ChainCardRule>> = {
  [GROCERY_CHAIN_LIDER]: {
    payment_method: "tarjeta_lider_bci",
    batch_kind: "cc_lider_boleta",
    master_account_id: liderMasterAccountId,
    branch_merchants: () => ccCardRegistry().boleta_sucursal_merchants,
    classify: classifyLiderLines,
    raw_line_prefix: receiptCardLineRawLinePrefix(GROCERY_CHAIN_LIDER),
  },
};

/** The card master a chain's receipts can write movements on; null for items-only chains. */
export function chainCardMasterAccountId(chain: string): number | null {
  const rule = CHAIN_CARD_RULES[chain];
  return rule ? rule.master_account_id() : null;
}

function cardPaidClp(parsed: ParsedReceipt, rule: ChainCardRule | undefined): number {
  if (!rule) return 0;
  return parsed.payments
    .filter((p) => p.method === rule.payment_method)
    .reduce((sum, p) => sum + p.amount_clp, 0);
}

function totalClp(parsed: ParsedReceipt): number {
  return parsed.payments.reduce((sum, p) => sum + p.amount_clp, 0);
}

// ---------------------------------------------------------------------------------------------
// Receipt + items write
// ---------------------------------------------------------------------------------------------

const RECEIPT_COLUMNS = `receipt_key, source, source_key, receipt_number, store_chain, branch, city, purchased_at,
     total_clp, discount_total_clp, receipt_discount_clp, receipt_discounts_json,
     payments_json, card_paid_clp, mi_club_points`;
const insertReceipt = db.prepare(
  `INSERT INTO grocery_receipts (${RECEIPT_COLUMNS})
   VALUES (@receipt_key, @source, @source_key, @receipt_number, @store_chain, @branch, @city, @purchased_at,
     @total_clp, @discount_total_clp, @receipt_discount_clp, @receipt_discounts_json,
     @payments_json, @card_paid_clp, @mi_club_points)`
);
const updateReceipt = db.prepare(
  `UPDATE grocery_receipts SET
     receipt_key = @receipt_key, source = @source, source_key = @source_key,
     receipt_number = @receipt_number, store_chain = @store_chain, branch = @branch, city = @city,
     purchased_at = @purchased_at, total_clp = @total_clp, discount_total_clp = @discount_total_clp,
     receipt_discount_clp = @receipt_discount_clp, receipt_discounts_json = @receipt_discounts_json,
     payments_json = @payments_json, card_paid_clp = @card_paid_clp, mi_club_points = @mi_club_points
   WHERE id = @id`
);

const selectItem = db.prepare(
  `SELECT id, description, product_id FROM grocery_receipt_items WHERE receipt_id = ? AND position = ?`
);
const insertItem = db.prepare(
  `INSERT INTO grocery_receipt_items (
     receipt_id, position, barcode, description, qty, qty_unit, unit_price_clp, total_clp,
     discount_clp, discount_labels_json
   ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
);
const updateItem = db.prepare(
  `UPDATE grocery_receipt_items SET barcode = ?, description = ?, qty = ?, qty_unit = ?,
     unit_price_clp = ?, total_clp = ?, discount_clp = ?, discount_labels_json = ?,
     product_id = ?, product_source = ?
   WHERE id = ?`
);
const deleteTailItems = db.prepare(
  `DELETE FROM grocery_receipt_items WHERE receipt_id = ? AND position >= ?`
);

const aliasByBarcode = db.prepare(
  `SELECT product_id FROM grocery_product_aliases WHERE store_chain = ? AND barcode = ?`
);
const aliasByDescription = db.prepare(
  `SELECT product_id FROM grocery_product_aliases WHERE store_chain = ? AND description = ?`
);
const stampItem = db.prepare(
  `UPDATE grocery_receipt_items SET product_id = ?, product_source = 'alias'
   WHERE id = ? AND product_id IS NULL`
);

/** Alias resolution for one chain: barcode identity first, printed description second. */
export function resolveAliasProductId(
  chain: string,
  barcode: string | null,
  description: string
): number | null {
  if (barcode) {
    const hit = aliasByBarcode.get(chain, barcode) as { product_id: number } | undefined;
    if (hit) return hit.product_id;
  }
  const hit = aliasByDescription.get(chain, description) as { product_id: number } | undefined;
  return hit?.product_id ?? null;
}

function writeReceiptRow(
  staged: StagedReceipt,
  receiptKey: string,
  resolution: Exclude<ReceiptResolution, { action: "skip" }>,
  rule: ChainCardRule | undefined
): number {
  const { parsed } = staged;
  const params = {
    receipt_key: receiptKey,
    source: staged.source,
    source_key: staged.source_key,
    receipt_number: parsed.boleta_number,
    store_chain: staged.chain,
    branch: parsed.sucursal,
    city: parsed.city,
    purchased_at: parsed.purchased_at,
    total_clp: totalClp(parsed),
    discount_total_clp: parsed.items.reduce((s, i) => s + i.discount_clp, 0),
    receipt_discount_clp: (parsed.receipt_discounts ?? []).reduce((s, d) => s + d.amount_clp, 0),
    receipt_discounts_json: parsed.receipt_discounts?.length
      ? JSON.stringify(parsed.receipt_discounts)
      : null,
    payments_json: JSON.stringify(parsed.payments),
    card_paid_clp: cardPaidClp(parsed, rule),
    mi_club_points: parsed.mi_club_points,
  };
  if (resolution.action === "insert") {
    return Number(insertReceipt.run(params).lastInsertRowid);
  }
  updateReceipt.run({ ...params, id: resolution.id });
  return resolution.id;
}

function upsertReceiptItems(receiptId: number, chain: string, parsed: ParsedReceipt): number {
  for (const item of parsed.items) {
    const existing = selectItem.get(receiptId, item.position) as
      | { id: number; description: string; product_id: number | null }
      | undefined;
    const labels = item.discount_labels.length ? JSON.stringify(item.discount_labels) : null;
    if (!existing) {
      insertItem.run(
        receiptId,
        item.position,
        item.barcode,
        item.description,
        item.qty,
        item.qty_unit,
        item.unit_price_clp,
        item.total_clp,
        item.discount_clp,
        labels
      );
    } else {
      // Preserve the stamp unless the printed description itself changed under this position.
      const keepStamp = existing.description === item.description;
      const productId = keepStamp ? existing.product_id : null;
      updateItem.run(
        item.barcode,
        item.description,
        item.qty,
        item.qty_unit,
        item.unit_price_clp,
        item.total_clp,
        item.discount_clp,
        labels,
        productId,
        productId != null ? "alias" : null,
        existing.id
      );
    }
  }
  deleteTailItems.run(receiptId, parsed.items.length);

  // Resolve still-unclassified items through the alias table.
  const unclassified = db
    .prepare(
      `SELECT id, barcode, description FROM grocery_receipt_items
       WHERE receipt_id = ? AND product_id IS NULL`
    )
    .all(receiptId) as { id: number; barcode: string | null; description: string }[];
  for (const item of unclassified) {
    const productId = resolveAliasProductId(chain, item.barcode, item.description);
    if (productId != null) stampItem.run(productId, item.id);
  }
  const stillNull = (
    db
      .prepare(`SELECT COUNT(*) AS c FROM grocery_receipt_items WHERE receipt_id = ? AND product_id IS NULL`)
      .get(receiptId) as { c: number }
  ).c;
  return parsed.items.length - stillNull;
}

const writeReceipt = db.transaction(
  (
    staged: StagedReceipt,
    receiptKey: string,
    resolution: Exclude<ReceiptResolution, { action: "skip" }>,
    rule: ChainCardRule | undefined
  ): { receiptId: number; classified: number } => {
    const receiptId = writeReceiptRow(staged, receiptKey, resolution, rule);
    const classified = upsertReceiptItems(receiptId, staged.chain, staged.parsed);
    return { receiptId, classified };
  }
);

/** Inclusive ISO end of the last fully-closed facturación; null when no statement exists. */
export function lastClosedPeriodEndIso(accountId: number): string | null {
  const bm = lastPdfBillingMonthForAccount(accountId);
  if (!bm) return null;
  return periodToIsoForBillingMonth(accountId, bm);
}

// ---------------------------------------------------------------------------------------------
// Import
// ---------------------------------------------------------------------------------------------

export type GroceryReceiptImportResult = {
  root: StagingRoot["kind"];
  dir: string;
  chain: string;
  source: GroceryReceiptSource;
  receipt_key: string;
  /** −1 in a dry run for a receipt that would be inserted. */
  receipt_id: number;
  /** `unchanged`: a current import stamp — nothing was read from or written to the DB. */
  receipt_status: "inserted" | "updated" | "replaced" | "skipped_duplicate" | "unchanged";
  /** replaced: the source this document displaced; skipped_duplicate: the source that owns the row. */
  other_source: GroceryReceiptSource | null;
  purchased_at: string;
  card_paid_clp: number;
  items: number;
  items_classified: number;
  movement:
    | { status: "created" | "duplicate" | "same_day_amount" }
    | { status: "closed_month" | "not_card_paid" | "chain_items_only" | "not_attempted" }
    /** Flagged: no map names the branch; the bank's own line for this day+amount will pair it. */
    | { status: "pending_branch"; branch: string }
    /** Paired with the bank's line (now or by an earlier card write); the branch is learned. */
    | { status: "matched"; branch: string; merchant: string | null };
};

const selectReceiptById = db.prepare(`SELECT receipt_key, source_key FROM grocery_receipts WHERE id = ?`);
const countClassified = db.prepare(
  `SELECT COUNT(*) AS c FROM grocery_receipt_items WHERE receipt_id = ? AND product_id IS NOT NULL`
);

/**
 * Stamp current AND the row it names still exists under that key (a wiped DB re-imports) AND,
 * when the stamp says this document owned the row, it still does — a higher-ranked document
 * taking the row over makes the displaced document re-run once, so its `skipped_duplicate` is
 * reported (and stamped) instead of silently standing as "inserted".
 */
function stampIsCurrent(staged: StagedReceipt): staged is StagedReceipt & { stamp: ImportStamp } {
  const stamp = staged.stamp;
  if (!stamp || stamp.import_version !== IMPORT_STAMP_VERSION || stamp.parsed_sha256 !== staged.parsed_sha256) return false;
  const row = selectReceiptById.get(stamp.receipt_id) as { receipt_key: string; source_key: string } | undefined;
  if (!row || row.receipt_key !== stamp.receipt_key) return false;
  const stampedAsOwner = stamp.receipt_status !== "skipped_duplicate";
  return !stampedAsOwner || row.source_key === staged.source_key;
}

function writeStamp(staged: StagedReceipt, result: GroceryReceiptImportResult): void {
  const stamp: ImportStamp = {
    import_version: IMPORT_STAMP_VERSION,
    parsed_sha256: staged.parsed_sha256,
    receipt_key: result.receipt_key,
    receipt_id: result.receipt_id,
    receipt_status: result.receipt_status,
    movement_status: result.movement.status,
    imported_at: new Date().toISOString(),
  };
  fs.writeFileSync(path.join(staged.path, "imported.json"), JSON.stringify(stamp, null, 1) + "\n");
}

export function importStagedGroceryReceipts(opts?: {
  roots?: StagingRoot[];
  dryRun?: boolean;
  /** Ignore import stamps: re-upsert every staged receipt. */
  full?: boolean;
}): GroceryReceiptImportResult[] {
  const staged = listStagedReceipts(opts?.roots);
  if (staged.length === 0) return [];

  // Resolved lazily per chain: an all-cash/other-card batch (and the test DB, which has no
  // Lider master) must import receipts without needing the card registry to resolve.
  const cardCtxByChain = new Map<string, { accountId: number; closedThrough: string | null }>();
  const cardContext = (chain: string, rule: ChainCardRule) => {
    let ctx = cardCtxByChain.get(chain);
    if (!ctx) {
      const accountId = rule.master_account_id();
      ctx = { accountId, closedThrough: lastClosedPeriodEndIso(accountId) };
      cardCtxByChain.set(chain, ctx);
    }
    return ctx;
  };
  const results: GroceryReceiptImportResult[] = [];

  for (const receipt of staged) {
    if (!opts?.full && stampIsCurrent(receipt)) {
      results.push({
        root: receipt.root,
        dir: receipt.dir,
        chain: receipt.chain,
        source: receipt.source,
        receipt_key: receipt.stamp.receipt_key,
        receipt_id: receipt.stamp.receipt_id,
        receipt_status: "unchanged",
        other_source: null,
        purchased_at: receipt.parsed.purchased_at,
        card_paid_clp: cardPaidClp(receipt.parsed, CHAIN_CARD_RULES[receipt.chain]),
        items: receipt.parsed.items.length,
        items_classified: (countClassified.get(receipt.stamp.receipt_id) as { c: number }).c,
        movement: { status: "not_attempted" },
      });
      continue;
    }
    const { receiptKey, resolution } = resolveReceiptOwnership(receipt);
    const rule = CHAIN_CARD_RULES[receipt.chain];
    const paid = cardPaidClp(receipt.parsed, rule);
    const purchaseIso = receipt.parsed.purchased_at.slice(0, 10);
    let receiptId = resolution.action === "insert" ? -1 : resolution.id;
    let classified = 0;
    if (resolution.action !== "skip" && !opts?.dryRun) {
      ({ receiptId, classified } = writeReceipt(receipt, receiptKey, resolution, rule));
    }

    let movement: GroceryReceiptImportResult["movement"];
    if (resolution.action === "skip") {
      movement = { status: "not_attempted" };
    } else if (!rule) {
      movement = { status: "chain_items_only" };
    } else if (paid <= 0) {
      movement = { status: "not_card_paid" };
    } else {
      const ctx = cardContext(receipt.chain, rule);
      const branch = receipt.parsed.sucursal;
      const stored = opts?.dryRun || receiptId < 0 ? null : receiptCardLineStatus(receiptId);
      const pending: PendingBranchReceipt = {
        receipt_id: receiptId,
        store_chain: receipt.chain,
        branch,
        card_line_account_id: ctx.accountId,
        purchase_ymd: purchaseIso,
        card_paid_clp: paid,
      };
      if (stored === "matched") {
        // Paired with the bank's own line by an earlier card write or an earlier run.
        movement = { status: "matched", branch, merchant: resolveBranchMerchant(receipt.chain, branch, rule.branch_merchants()) };
      } else if (ctx.closedThrough != null && purchaseIso <= ctx.closedThrough) {
        // Statement-covered. A receipt still pending at the close now has the statement's own
        // line to pair with, so it gets one more attempt before settling.
        if (stored === "pending_branch") {
          const learned = learnBranchForPendingReceipt(pending);
          movement =
            learned.status === "learned"
              ? { status: "matched", branch, merchant: learned.merchant }
              : { status: "closed_month" };
        } else {
          movement = { status: "closed_month" };
        }
      } else {
        const merchant = resolveBranchMerchant(receipt.chain, branch, rule.branch_merchants());
        if (!merchant) {
          if (opts?.dryRun) {
            movement = { status: "pending_branch", branch };
          } else {
            // Flag, don't fail: the bank's own line for this day and amount — whichever source
            // writes it — pairs the receipt and teaches the branch's merchant string. The line
            // may already be there (a paste that beat the receipt), so try at once.
            markReceiptCardLine(receiptId, "pending_branch", ctx.accountId);
            const learned = learnBranchForPendingReceipt(pending);
            movement =
              learned.status === "learned"
                ? { status: "matched", branch, merchant: learned.merchant }
                : { status: "pending_branch", branch };
          }
        } else if (opts?.dryRun) {
          movement = { status: "created" };
        } else {
          const line: CcWebPasteLine = {
            transaction_date: purchaseIso,
            merchant,
            amount_clp: paid,
            amount_usd: null,
            currency: "clp",
            raw_line: `${rule.raw_line_prefix}|${receipt.parsed.boleta_number}|${purchaseIso}|${paid}`,
          };
          const { importable } = rule.classify(ctx.accountId, [line]);
          if (importable.length === 0) {
            movement = { status: "same_day_amount" };
          } else {
            const res = importCcWebPasteLines(ctx.accountId, { lines: importable, errors: [] }, rule.batch_kind);
            movement = { status: res.inserted > 0 ? "created" : "duplicate" };
          }
          markReceiptCardLine(receiptId, movement.status === "created" ? "created" : "covered", ctx.accountId);
        }
      }
    }

    const receiptStatus: GroceryReceiptImportResult["receipt_status"] =
      resolution.action === "insert"
        ? "inserted"
        : resolution.action === "update"
          ? "updated"
          : resolution.action === "replace"
            ? "replaced"
            : "skipped_duplicate";
    const result: GroceryReceiptImportResult = {
      root: receipt.root,
      dir: receipt.dir,
      chain: receipt.chain,
      source: receipt.source,
      receipt_key: receiptKey,
      receipt_id: receiptId,
      receipt_status: receiptStatus,
      other_source:
        resolution.action === "replace"
          ? resolution.displaced
          : resolution.action === "skip"
            ? resolution.owner
            : null,
      purchased_at: receipt.parsed.purchased_at,
      card_paid_clp: paid,
      items: receipt.parsed.items.length,
      items_classified: classified,
      movement,
    };
    if (!opts?.dryRun && movementIsTerminal(movement.status)) writeStamp(receipt, result);
    results.push(result);
  }
  return results;
}

/**
 * Lider «Boleta Digital» import: staged e-mail receipts → grocery tables + open-month card lines.
 *
 * Two independent outcomes per boleta:
 *
 *  1. ALWAYS (idempotent, full history): the receipt + items land in `grocery_receipts` /
 *     `grocery_receipt_items` with provenance frozen (chain, branch, city, printed local
 *     datetime, payment legs). Items resolve to canonical products through
 *     `grocery_product_aliases` (barcode first, printed description second) and STAMP the
 *     resolution; re-imports upsert by (receipt, position) and preserve stamps unless the
 *     printed description itself changed (a parser fix that renames a line sends it back to
 *     unclassified — re-matching an old rule against new text would be silent misclassification).
 *
 *  2. Card movement, only when BOTH hold: the boleta was paid with the Lider/BCI card (its
 *     TARJETA LIDER BCI leg — cash/TBK/other-card boletas store items only), AND the purchase
 *     date is inside the account's open facturación (closed months are statement-covered; a
 *     boleta movement there would be noise the PDF already supersedes). The line goes through
 *     the web-paste path on the registry-resolved Lider master with the bank's exact merchant
 *     string for the sucursal (`boleta_sucursal_merchants`), so dedupe collides head-on with
 *     the feed/statement rendering; the same-day+amount guard covers a differently-named twin.
 *     An unknown sucursal on a movement-eligible boleta is reported, never guessed.
 */
import fs from "node:fs";
import path from "node:path";

import { ccCardRegistry } from "./ccCardRegistry.js";
import { lastPdfBillingMonthForAccount, periodToIsoForBillingMonth } from "./ccManualBillingMonth.js";
import { importCcWebPasteLines } from "./accountImports.js";
import type { CcWebPasteLine } from "./ccWebPasteParse.js";
import { classifyLiderLines, liderMasterAccountId } from "./liderMovementsImport.js";
import { resolveCfraserCsvDir } from "./cfraserPaths.js";
import { db } from "./db.js";

export const GROCERY_CHAIN_LIDER = "lider";

export function liderBoletasStagedDir(cfraserDir = resolveCfraserCsvDir()): string {
  return path.join(cfraserDir, "lider-boletas", "staged");
}

/** Any staged boleta PDF at all — the pipeline gate (parsing happens inside the import step). */
export function hasStagedBoletaPdfs(stagedDir = liderBoletasStagedDir()): boolean {
  if (!fs.existsSync(stagedDir)) return false;
  return fs
    .readdirSync(stagedDir)
    .some((name) => fs.existsSync(path.join(stagedDir, name, "Boleta.pdf")));
}

type StagedBoletaMeta = { message_id: string; subject: string; date: string; body_text: string };

type ParsedBoletaItem = {
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

type ParsedBoleta = {
  boleta_number: string;
  caja: string;
  sucursal: string;
  city: string | null;
  purchased_at: string;
  template: string;
  items: ParsedBoletaItem[];
  payments: { method: string; amount_clp: number }[];
  total_printed_clp: number | null;
  articles_declared: number | null;
  mi_club_points: number | null;
  parser_version: number;
};

export type StagedBoleta = { dir: string; meta: StagedBoletaMeta; parsed: ParsedBoleta };

/** Staged boleta dirs that have BOTH meta.json and parsed.json (run the parser first). */
export function listStagedBoletas(stagedDir = liderBoletasStagedDir()): StagedBoleta[] {
  if (!fs.existsSync(stagedDir)) return [];
  const out: StagedBoleta[] = [];
  for (const name of fs.readdirSync(stagedDir).sort()) {
    const dir = path.join(stagedDir, name);
    const metaFile = path.join(dir, "meta.json");
    const parsedFile = path.join(dir, "parsed.json");
    if (!fs.existsSync(metaFile) || !fs.existsSync(parsedFile)) continue;
    out.push({
      dir: name,
      meta: JSON.parse(fs.readFileSync(metaFile, "utf8")) as StagedBoletaMeta,
      parsed: JSON.parse(fs.readFileSync(parsedFile, "utf8")) as ParsedBoleta,
    });
  }
  return out;
}

function cardPaidClp(parsed: ParsedBoleta): number {
  return parsed.payments
    .filter((p) => p.method === "tarjeta_lider_bci")
    .reduce((sum, p) => sum + p.amount_clp, 0);
}

function totalClp(parsed: ParsedBoleta): number {
  return parsed.payments.reduce((sum, p) => sum + p.amount_clp, 0);
}

const upsertReceipt = db.prepare(
  `INSERT INTO grocery_receipts (
     source, source_key, receipt_number, store_chain, branch, city, purchased_at,
     total_clp, discount_total_clp, payments_json, card_paid_clp, mi_club_points
   ) VALUES (@source, @source_key, @receipt_number, @store_chain, @branch, @city, @purchased_at,
     @total_clp, @discount_total_clp, @payments_json, @card_paid_clp, @mi_club_points)
   ON CONFLICT(source_key) DO UPDATE SET
     receipt_number = excluded.receipt_number, store_chain = excluded.store_chain,
     branch = excluded.branch, city = excluded.city, purchased_at = excluded.purchased_at,
     total_clp = excluded.total_clp, discount_total_clp = excluded.discount_total_clp,
     payments_json = excluded.payments_json, card_paid_clp = excluded.card_paid_clp,
     mi_club_points = excluded.mi_club_points`
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

export type BoletaImportResult = {
  dir: string;
  receipt_id: number;
  purchased_at: string;
  card_paid_clp: number;
  items: number;
  items_classified: number;
  movement:
    | { status: "created" | "duplicate" | "same_day_amount" }
    | { status: "closed_month" | "not_card_paid" }
    | { status: "unknown_sucursal"; sucursal: string };
};

function upsertBoletaReceipt(staged: StagedBoleta): { receiptId: number; classified: number } {
  const { meta, parsed } = staged;
  upsertReceipt.run({
    source: "lider_email",
    source_key: meta.message_id,
    receipt_number: parsed.boleta_number,
    store_chain: GROCERY_CHAIN_LIDER,
    branch: parsed.sucursal,
    city: parsed.city,
    purchased_at: parsed.purchased_at,
    total_clp: totalClp(parsed),
    discount_total_clp: parsed.items.reduce((s, i) => s + i.discount_clp, 0),
    payments_json: JSON.stringify(parsed.payments),
    card_paid_clp: cardPaidClp(parsed),
    mi_club_points: parsed.mi_club_points,
  });
  const receiptId = (
    db.prepare(`SELECT id FROM grocery_receipts WHERE source_key = ?`).get(meta.message_id) as {
      id: number;
    }
  ).id;

  let classified = 0;
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
    const productId = resolveAliasProductId(GROCERY_CHAIN_LIDER, item.barcode, item.description);
    if (productId != null) stampItem.run(productId, item.id);
  }
  const total = parsed.items.length;
  const stillNull = (
    db
      .prepare(`SELECT COUNT(*) AS c FROM grocery_receipt_items WHERE receipt_id = ? AND product_id IS NULL`)
      .get(receiptId) as { c: number }
  ).c;
  classified = total - stillNull;
  return { receiptId, classified };
}

/** Inclusive ISO end of the last fully-closed facturación; null when no statement exists. */
export function lastClosedPeriodEndIso(accountId: number): string | null {
  const bm = lastPdfBillingMonthForAccount(accountId);
  if (!bm) return null;
  return periodToIsoForBillingMonth(accountId, bm);
}

export function importStagedBoletas(opts?: {
  stagedDir?: string;
  dryRun?: boolean;
}): BoletaImportResult[] {
  const staged = listStagedBoletas(opts?.stagedDir);
  if (staged.length === 0) return [];

  // Resolved lazily: an all-cash/other-card batch (and the test DB, which has no Lider
  // master) must import receipts without needing the card registry to resolve.
  let cardCtx: { accountId: number; closedThrough: string | null } | null = null;
  const cardContext = () => {
    if (!cardCtx) {
      const accountId = liderMasterAccountId();
      cardCtx = { accountId, closedThrough: lastClosedPeriodEndIso(accountId) };
    }
    return cardCtx;
  };
  const sucursalMerchants = ccCardRegistry().boleta_sucursal_merchants;
  const results: BoletaImportResult[] = [];

  for (const boleta of staged) {
    const paid = cardPaidClp(boleta.parsed);
    const purchaseIso = boleta.parsed.purchased_at.slice(0, 10);
    let receiptId = -1;
    let classified = 0;
    if (!opts?.dryRun) {
      ({ receiptId, classified } = upsertBoletaReceipt(boleta));
    }

    let movement: BoletaImportResult["movement"];
    if (paid <= 0) {
      movement = { status: "not_card_paid" };
    } else if (cardContext().closedThrough != null && purchaseIso <= cardContext().closedThrough!) {
      movement = { status: "closed_month" };
    } else {
      const merchant = sucursalMerchants[boleta.parsed.sucursal];
      if (!merchant) {
        movement = { status: "unknown_sucursal", sucursal: boleta.parsed.sucursal };
      } else if (opts?.dryRun) {
        movement = { status: "created" };
      } else {
        const line: CcWebPasteLine = {
          transaction_date: purchaseIso,
          merchant,
          amount_clp: paid,
          amount_usd: null,
          currency: "clp",
          raw_line: `lider-boleta|${boleta.parsed.boleta_number}|${purchaseIso}|${paid}`,
        };
        const { importable, sameDayAmount } = classifyLiderLines(cardContext().accountId, [line]);
        if (importable.length === 0) {
          movement = { status: "same_day_amount" };
          void sameDayAmount;
        } else {
          const res = importCcWebPasteLines(
            cardContext().accountId,
            { lines: importable, errors: [] },
            "cc_lider_boleta"
          );
          movement = { status: res.inserted > 0 ? "created" : "duplicate" };
        }
      }
    }

    results.push({
      dir: boleta.dir,
      receipt_id: receiptId,
      purchased_at: boleta.parsed.purchased_at,
      card_paid_clp: paid,
      items: boleta.parsed.items.length,
      items_classified: classified,
      movement,
    });
  }
  return results;
}

/**
 * Traspaso de deuda USD↔CLP leg links (`cc_traspaso_deuda_links`).
 *
 * A «traspaso de deuda internacional» reclassifies USD debt onto the CLP side of the same
 * card: the USD statement carries an abono (negative US$) and the CLP statement of the same
 * facturación carries the matching cargo at the bank's own conversion. No cash moves and the
 * card's total debt is unchanged, so the pair must net to exactly zero — valuing the USD leg
 * at a looked-up fx rate instead leaves a residue in the owed walk. The link row stores the
 * hard conversion; `normalizedPostCloseLines` values a linked USD leg at minus the CLP leg's
 * booked pesos.
 *
 * Links are derived state (movement_mirror_merges' cousin for statement lines): rebuilt per
 * account on every PDF statement import — line replacement cascades old rows away, so the
 * relink runs inside the same transaction. Web-paste bucket lines are excluded: a pasted
 * traspaso leg can legitimately arrive without its twin (per-currency pastes), stays
 * fx-converted like today, and is superseded by the PDF import that then links the real pair.
 */
import { invalidateCcBillingDetail } from "./aggregationCache.js";
import { isCcTraspasoDeudaMerchant } from "./ccStatementSection3.js";
import { db } from "./db.js";

export type CcTraspasoDeudaPair = {
  statement_date: string;
  clp_line_id: number;
  usd_line_id: number;
  amount_clp: number;
  amount_usd: number;
};

type TraspasoLegRow = {
  id: number;
  statement_date: string;
  currency: string;
  merchant: string | null;
  amount_clp: number | null;
  amount_usd: number | null;
};

// A traspaso converts near market fx; a rate far outside means the pairing grabbed wrong lines.
const MIN_PLAUSIBLE_CLP_PER_USD = 300;
const MAX_PLAUSIBLE_CLP_PER_USD = 3000;

const listTraspasoLegCandidates = db.prepare(
  `SELECT l.id, s.statement_date, s.currency, l.merchant, l.amount_clp, l.amount_usd
   FROM cc_statement_lines l
   JOIN cc_statements s ON s.id = l.statement_id
   WHERE s.account_id = ? AND l.installment_flag = 0
     AND UPPER(l.merchant) LIKE '%TRASPASO%'
     AND s.source_pdf NOT LIKE 'import:web-paste%'
   ORDER BY s.statement_date, s.currency, l.id`
);

const delLinksForAccount = db.prepare(`DELETE FROM cc_traspaso_deuda_links WHERE account_id = ?`);

const insLink = db.prepare(
  `INSERT INTO cc_traspaso_deuda_links (account_id, clp_line_id, usd_line_id, amount_clp, amount_usd)
   VALUES (?, ?, ?, ?, ?)`
);

const listLinksForAccount = db.prepare(
  `SELECT usd_line_id, amount_clp FROM cc_traspaso_deuda_links WHERE account_id = ?`
);

/**
 * Pair every traspaso leg on the account's PDF statements, one CLP + one USD leg per
 * statement close. Throws on any unpairable state — a lone leg means the facturación's other
 * statement currency is missing from the ledger, and >1 per side needs amount-aware pairing
 * that no real statement has required yet.
 */
export function computeCcTraspasoDeudaPairsForAccount(accountId: number): CcTraspasoDeudaPair[] {
  const legs = (listTraspasoLegCandidates.all(accountId) as TraspasoLegRow[]).filter((r) =>
    isCcTraspasoDeudaMerchant(r.merchant)
  );
  const byStatementDate = new Map<string, TraspasoLegRow[]>();
  for (const leg of legs) {
    const group = byStatementDate.get(leg.statement_date) ?? [];
    group.push(leg);
    byStatementDate.set(leg.statement_date, group);
  }

  const pairs: CcTraspasoDeudaPair[] = [];
  for (const [statementDate, group] of byStatementDate) {
    const clpLegs = group.filter((r) => String(r.currency).toLowerCase() === "clp");
    const usdLegs = group.filter((r) => String(r.currency).toLowerCase() === "usd");
    if (clpLegs.length !== 1 || usdLegs.length !== 1) {
      throw new Error(
        `traspaso deuda ${statementDate} (account ${accountId}): expected exactly one CLP and one USD leg, ` +
          `got ${clpLegs.length} clp / ${usdLegs.length} usd (line ids ${group.map((r) => r.id).join(", ")}). ` +
          `Import the facturación's missing statement currency before linking.`
      );
    }
    const clp = clpLegs[0]!;
    const usd = usdLegs[0]!;
    const amountClp = clp.amount_clp;
    const amountUsd = usd.amount_usd;
    if (amountClp == null || !Number.isFinite(amountClp) || amountClp <= 0) {
      throw new Error(
        `traspaso deuda ${statementDate} (account ${accountId}): CLP leg ${clp.id} must carry positive booked pesos, got ${amountClp}`
      );
    }
    if (amountUsd == null || !Number.isFinite(amountUsd) || amountUsd >= 0) {
      throw new Error(
        `traspaso deuda ${statementDate} (account ${accountId}): USD leg ${usd.id} must be a negative abono, got ${amountUsd}`
      );
    }
    const rate = amountClp / Math.abs(amountUsd);
    if (rate < MIN_PLAUSIBLE_CLP_PER_USD || rate > MAX_PLAUSIBLE_CLP_PER_USD) {
      throw new Error(
        `traspaso deuda ${statementDate} (account ${accountId}): implied rate ${rate.toFixed(2)} CLP/USD ` +
          `outside [${MIN_PLAUSIBLE_CLP_PER_USD}, ${MAX_PLAUSIBLE_CLP_PER_USD}] — lines ${clp.id}/${usd.id} are not one conversion`
      );
    }
    pairs.push({
      statement_date: statementDate,
      clp_line_id: clp.id,
      usd_line_id: usd.id,
      amount_clp: Math.round(amountClp),
      amount_usd: Math.abs(amountUsd),
    });
  }
  return pairs;
}

/** Full rebuild for the account (links are derived state); safe inside an outer transaction. */
export function relinkCcTraspasoDeudaLinksForAccount(accountId: number): { links: number } {
  const pairs = computeCcTraspasoDeudaPairsForAccount(accountId);
  db.transaction(() => {
    delLinksForAccount.run(accountId);
    for (const p of pairs) {
      insLink.run(accountId, p.clp_line_id, p.usd_line_id, p.amount_clp, p.amount_usd);
    }
  })();
  // The memoized post-close line stream bakes linked CLP values in.
  invalidateCcBillingDetail(accountId);
  return { links: pairs.length };
}

/** Booked CLP by USD-leg line id — the owed walk values a linked USD abono at minus this. */
export function ccTraspasoLinkedClpByUsdLineId(accountId: number): Map<number, number> {
  const rows = listLinksForAccount.all(accountId) as { usd_line_id: number; amount_clp: number }[];
  return new Map(rows.map((r) => [r.usd_line_id, r.amount_clp]));
}

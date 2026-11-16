/**
 * Traspaso de deuda leg links (`cc_traspaso_deuda_links`: the debt leaves the `from` leg's
 * currency and enters the `to` leg's, migration 322).
 *
 * A «traspaso de deuda internacional» reclassifies debt in another currency onto the side of the
 * card's main statement (its issuer's primary currency): the other currency's statement carries an
 * abono (a negative amount) and the main statement of the same facturación carries the matching
 * cargo at the bank's own conversion. No cash moves and the card's total debt is unchanged, so the
 * pair must net to exactly zero — valuing the abono at a looked-up rate instead leaves a residue in
 * the owed walk. The link row stores the hard conversion; `normalizedPostCloseLines` values a
 * linked abono at minus what its cargo is booked at.
 *
 * Links are derived state (movement_mirror_merges' cousin for statement lines): rebuilt per
 * account on every PDF statement import — line replacement cascades old rows away, so the
 * relink runs inside the same transaction. Web-paste bucket lines are excluded: a pasted
 * traspaso leg can legitimately arrive without its twin (per-currency pastes), stays
 * fx-converted like today, and is superseded by the PDF import that then links the real pair.
 */

import { db } from "./db.js";
import { cardPrimaryStatementCurrency } from "./cards/cardCurrencies.js";
import { debtFrameClp, REAL_DEBT_FRAME_RATES } from "./ccExpenseAmountClp.js";
import { isHomeCurrency } from "./displayUnits.js";
import { convertCurrency } from "./rates.js";
import { parseDdMmYyToIso } from "nw-tracker-contracts";

/** One traspaso: the cargo on the main statement (`to`) and the abono it reclassifies (`from`, its amount positive). */
export type CcTraspasoDeudaPair = {
  statement_date: string;
  to_line_id: number;
  to_currency: string;
  to_amount: number;
  from_line_id: number;
  from_currency: string;
  from_amount: number;
};

type TraspasoLegRow = {
  id: number;
  statement_date: string;
  currency: string;
  amount: number | null;
};

/**
 * A traspaso converts near the market rate: the bank's conversion may sit this factor above or
 * below the stored close of the pair on the facturación's close day; further away means the
 * pairing grabbed two lines that are not one conversion.
 */
export const TRASPASO_RATE_TOLERANCE_FACTOR = 1.25;

const listTraspasoLegCandidates = db.prepare(
  `SELECT l.id, s.statement_date, l.currency, l.amount
   FROM cc_statement_lines l
   JOIN cc_statements s ON s.id = l.statement_id
   WHERE s.account_id = ? AND l.kind = 'card_debt_transfer'
     AND s.source_kind NOT IN ('listing_open', 'listing_other')
   ORDER BY s.statement_date, s.currency, l.id`
);

const delLinksForAccount = db.prepare(`DELETE FROM cc_traspaso_deuda_links WHERE account_id = ?`);

const insLink = db.prepare(
  `INSERT INTO cc_traspaso_deuda_links (account_id, to_line_id, to_currency, to_amount, from_line_id, from_currency, from_amount)
   VALUES (?, ?, ?, ?, ?, ?, ?)`
);

const listLinksForAccount = db.prepare(
  `SELECT t.from_line_id, t.to_currency, t.to_amount, s.statement_date
   FROM cc_traspaso_deuda_links t
   JOIN cc_statement_lines l ON l.id = t.from_line_id
   JOIN cc_statements s ON s.id = l.statement_id
   WHERE t.account_id = ? AND t.from_currency = ?`
);

/**
 * Pair every traspaso leg on the account's PDF statements: per statement close, one leg in the
 * currency of the card's main statement (the cargo) and one in another currency (the abono).
 * Throws on any unpairable state — a lone leg means the facturación's other statement currency is
 * missing from the ledger, and more than one per side needs amount-aware pairing that no real
 * statement has required yet.
 */
export function computeCcTraspasoDeudaPairsForAccount(accountId: number): CcTraspasoDeudaPair[] {
  // The line's stored kind (`cards/lineKinds.ts`): a traspaso de deuda leg.
  const legs = listTraspasoLegCandidates.all(accountId) as TraspasoLegRow[];
  if (legs.length === 0) return [];
  const primary = cardPrimaryStatementCurrency(accountId);
  const byStatementDate = new Map<string, TraspasoLegRow[]>();
  for (const leg of legs) {
    const group = byStatementDate.get(leg.statement_date) ?? [];
    group.push(leg);
    byStatementDate.set(leg.statement_date, group);
  }

  const pairs: CcTraspasoDeudaPair[] = [];
  for (const [statementDate, group] of byStatementDate) {
    const where = `traspaso deuda ${statementDate} (account ${accountId})`;
    const toLegs = group.filter((r) => r.currency === primary);
    const fromLegs = group.filter((r) => r.currency !== primary);
    if (toLegs.length !== 1 || fromLegs.length !== 1) {
      const counts = new Map<string, number>();
      for (const r of group) counts.set(r.currency, (counts.get(r.currency) ?? 0) + 1);
      throw new Error(
        `${where}: expected exactly one ${primary.toUpperCase()} leg and one leg in another currency, ` +
          `got ${[...counts].map(([c, n]) => `${n} ${c}`).join(" / ")} (line ids ${group.map((r) => r.id).join(", ")}). ` +
          `Import the facturación's missing statement currency before linking.`
      );
    }
    const to = toLegs[0]!;
    const from = fromLegs[0]!;
    const toCode = to.currency.toUpperCase();
    const fromCode = from.currency.toUpperCase();
    if (to.amount == null || !Number.isFinite(to.amount) || to.amount <= 0) {
      throw new Error(`${where}: ${toCode} leg ${to.id} must carry a positive booked amount, got ${to.amount}`);
    }
    if (from.amount == null || !Number.isFinite(from.amount) || from.amount >= 0) {
      throw new Error(`${where}: ${fromCode} leg ${from.id} must be a negative abono, got ${from.amount}`);
    }
    const closeIso = parseDdMmYyToIso(statementDate);
    if (!closeIso) throw new Error(`${where}: unparsable statement date`);
    const stored = convertCurrency(1, from.currency, primary, closeIso, { side: "mid", storedOnly: true });
    if (stored == null || !(stored > 0)) {
      throw new Error(`${where}: no ${fromCode}/${toCode} rate on or before ${closeIso} to check the conversion against`);
    }
    const rate = to.amount / Math.abs(from.amount);
    if (rate < stored / TRASPASO_RATE_TOLERANCE_FACTOR || rate > stored * TRASPASO_RATE_TOLERANCE_FACTOR) {
      throw new Error(
        `${where}: implied rate ${rate.toPrecision(6)} ${toCode}/${fromCode} is more than a factor of ` +
          `${TRASPASO_RATE_TOLERANCE_FACTOR} from the stored ${stored.toPrecision(6)} of ${closeIso} — ` +
          `lines ${to.id}/${from.id} are not one conversion`
      );
    }
    pairs.push({
      statement_date: statementDate,
      to_line_id: to.id,
      to_currency: to.currency,
      // Pesos are whole; another currency keeps the amount its line prints.
      to_amount: isHomeCurrency(to.currency) ? Math.round(to.amount) : to.amount,
      from_line_id: from.id,
      from_currency: from.currency,
      from_amount: Math.abs(from.amount),
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
      insLink.run(accountId, p.to_line_id, p.to_currency, p.to_amount, p.from_line_id, p.from_currency, p.from_amount);
    }
  })();
  // The memoized post-close line stream bakes linked CLP values in.
  return { links: pairs.length };
}

/**
 * The pesos a traspaso's cargo is booked at: its amount when the card's main statement is in pesos,
 * otherwise that amount in the statement frame of its facturación (`frameDateIso`: the pay-by − 1,
 * `balanceUsdFxDateIso`) — what the owed walk values the cargo line itself at, so the pair nets to
 * zero. Throws when that rate is not on file.
 */
export function traspasoToLegClp(to: { amount: number; currency: string }, frameDateIso: string | null, what: string): number {
  if (isHomeCurrency(to.currency)) return Math.round(to.amount);
  return debtFrameClp(to.amount, to.currency, frameDateIso, REAL_DEBT_FRAME_RATES, what);
}

/**
 * Booked pesos of the cargo by abono line id, for the abonos in `currency` — the owed walk values
 * a linked abono at minus this. `frameDateOf` gives the statement-frame day of a facturación by
 * its statement date; it is read only for a card whose main statement is not in pesos.
 */
export function ccTraspasoLinkedClpByForeignLineId(
  accountId: number,
  currency: string,
  frameDateOf: (statementDate: string) => string | null
): Map<number, number> {
  const rows = listLinksForAccount.all(accountId, currency) as {
    from_line_id: number;
    to_currency: string;
    to_amount: number;
    statement_date: string;
  }[];
  return new Map(
    rows.map((r) => [
      r.from_line_id,
      traspasoToLegClp(
        { amount: r.to_amount, currency: r.to_currency },
        isHomeCurrency(r.to_currency) ? null : frameDateOf(r.statement_date),
        `traspaso deuda ${r.statement_date} (account ${accountId})`
      ),
    ])
  );
}

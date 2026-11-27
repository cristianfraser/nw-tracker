/**
 * A cartola is imported only into a ledger that agrees with it (fail fast): the account's balance
 * as the bank dates it (`nonAnchorClpFlowTotals`, by the bank's posting day, the anchor counted as
 * the opening of history) must equal the cartola's printed opening balance at its opening day
 * before anything is written, and its printed closing balance at its closing day once the plan is
 * applied (`checkingCartolaMonthBounds.ts` for the days). A failure refuses the cartola
 * (`CartolaImportRefusal`): the checks run inside its transaction, so nothing of it is written.
 *
 * Which anchor the checks read (`cartolaLedgerFrame`):
 *  - **established**: an anchor is on file and a cartola month at or before this one is on file.
 *    The checks read the anchor on file, and once the plan is applied the anchor derived from the
 *    newest cartola must still be that anchor (the newest month still lands on its closing balance;
 *    for a month in the middle of history, the later months still hold). The anchor never moves.
 *  - **derives the anchor**: the account's first cartola, one earlier than every month on file
 *    (it starts the account's history), or any after the anchor was cleared by hand or wiped. Once
 *    the plan is applied the anchor is derived from the newest cartola and the checks read that
 *    anchor. The import run carries it (the run's next cartolas are checked against it, as the
 *    established anchor) and writes it once its cartolas are in (`finishCartolaImportRun`,
 *    `ensureCheckingLedgerAnchor` with `repin`).
 * A balance the cartola does not print (a cuenta vista slice inside a document's span with no
 * daily balance) is not checked. The saldo identity (`assertCheckingCartolaSaldoIdentity`: the
 * printed balances against the cartola's own movements) and the saldo chain
 * (`validateCartolaSaldoChain`: its opening against the previous month's printed closing) compare
 * printed figures with each other; only this guard compares them with the ledger.
 */
import type { Database } from "better-sqlite3";
import { db } from "./db.js";
import type { ParsedCheckingCartola } from "./checkingCartolaParse.js";
import {
  getCartolaDerivedAnchor,
  nonAnchorClpFlowTotals,
  storedCheckingLedgerAnchor,
} from "./checkingCartolaBalances.js";
import { cartolaClosingDay, cartolaOpeningDay } from "./checkingCartolaMonthBounds.js";

export type CartolaRefusalReason =
  | "ledger_opening"
  | "ledger_closing"
  | "anchor_would_move"
  | "ledger_drift"
  | "second_document_differs"
  | "tax_settlement"
  /** A month imported again in place would change a row's category or shown name (`checkingRestatementCarry.ts`). */
  | "restatement_identity";

/** A cartola the import refuses: nothing of it is written; `problems` says why, line by line. */
export class CartolaImportRefusal extends Error {
  constructor(
    readonly periodMonth: string,
    readonly document: string,
    readonly reason: CartolaRefusalReason,
    readonly problems: string[]
  ) {
    super(`Cartola ${periodMonth} (${document}) refused: ${problems.join("; ")}`);
  }
}

export type CheckingLedgerAnchorAt = { amount_clp: number; occurred_on: string };

/**
 * `rebuild`: the deliberate repair run (`rebuildCheckingLedgerFromCartolas`): no cartola is checked
 * on its own; the run re-derives the anchor and then every month on file must hold.
 */
export type CartolaLedgerFrame = { kind: "established"; anchor: CheckingLedgerAnchorAt } | { kind: "derives_anchor" } | { kind: "rebuild" };

/**
 * Which anchor the cartola of `periodMonth` is checked against (see the module doc). `runAnchor`:
 * the anchor an earlier cartola of the same run derived, not written yet; it stands for the anchor
 * on file.
 */
export function cartolaLedgerFrame(
  accountId: number,
  periodMonth: string,
  dbHandle: Database = db,
  runAnchor: CheckingLedgerAnchorAt | null = null
): CartolaLedgerFrame {
  const anchor = runAnchor ?? storedCheckingLedgerAnchor(accountId, dbHandle);
  if (anchor == null) return { kind: "derives_anchor" };
  const atOrBefore = dbHandle
    .prepare(`SELECT 1 FROM checking_cartola_imports WHERE account_id = ? AND period_month <= ? LIMIT 1`)
    .get(accountId, periodMonth);
  return atOrBefore == null ? { kind: "derives_anchor" } : { kind: "established", anchor: { amount_clp: anchor.amount_clp, occurred_on: anchor.occurred_on } };
}

/** The account's balance at the end of `ymd` by the bank's posting day, `anchorClp` as the opening. */
export function cartolaLedgerBalanceAt(accountId: number, ymd: string, anchorClp: number, dbHandle: Database = db): number {
  return anchorClp + nonAnchorClpFlowTotals(accountId, { toYmd: ymd }, dbHandle).net_clp;
}

function balanceProblem(what: "opening" | "closing", day: string, printed: number, found: number): string {
  return `the ledger at ${day} reads ${found} CLP but the cartola's ${what} balance is ${printed} CLP (ledger − cartola = ${found - printed})`;
}

/**
 * The ledger already disagrees with the cartolas on file (established frame, the anchor on file):
 * the anchor they derive is not the one on file. Not this cartola's doing — refused as its own
 * condition, before anything is written, so no cartola is blamed for an earlier drift.
 */
export function assertNoLedgerDrift(accountId: number, cartola: ParsedCheckingCartola, frame: CartolaLedgerFrame, fromRun: boolean, dbHandle: Database = db): void {
  if (frame.kind !== "established" || fromRun) return;
  const derived = getCartolaDerivedAnchor(accountId, dbHandle);
  if (derived == null) return;
  if (derived.amount_clp === frame.anchor.amount_clp && derived.occurred_on === frame.anchor.occurred_on) return;
  throw new CartolaImportRefusal(cartola.period_month, cartola.source_file, "ledger_drift", [
    `the ledger already disagrees with the cartolas on file before this one: the newest (${derived.period_month}) derives an anchor of ` +
      `${derived.amount_clp} CLP on ${derived.occurred_on}, the one on file is ${frame.anchor.amount_clp} CLP on ${frame.anchor.occurred_on} ` +
      `(difference ${derived.amount_clp - frame.anchor.amount_clp}); find the month off its cartola (the month table) and repair it, or rebuild ` +
      `the ledger from the cartolas (server/scripts/rebuild-checking-ledger-from-cartolas.ts); nothing of this cartola was written`,
  ]);
}

/** The printed opening balance against the ledger before anything is written (established frame only). */
export function assertCartolaOpeningAgrees(accountId: number, cartola: ParsedCheckingCartola, frame: CartolaLedgerFrame, dbHandle: Database = db): void {
  if (frame.kind !== "established" || cartola.saldo_inicial_clp == null) return;
  const day = cartolaOpeningDay(cartola);
  const found = cartolaLedgerBalanceAt(accountId, day, frame.anchor.amount_clp, dbHandle);
  if (found !== cartola.saldo_inicial_clp) {
    throw new CartolaImportRefusal(cartola.period_month, cartola.source_file, "ledger_opening", [
      balanceProblem("opening", day, cartola.saldo_inicial_clp, found) +
        " — a movement before the month is missing or extra; nothing of this cartola was written",
    ]);
  }
}

/**
 * A printed balance the same document brings for a month on file (`updateCheckingCartolaImportSaldos`)
 * must agree with the ledger as well (established frame; nothing else is written).
 */
export function assertCartolaSaldoRefreshAgrees(accountId: number, cartola: ParsedCheckingCartola, dbHandle: Database = db): void {
  const frame = cartolaLedgerFrame(accountId, cartola.period_month, dbHandle);
  if (frame.kind !== "established") return;
  assertCartolaOpeningAgrees(accountId, cartola, frame, dbHandle);
  if (cartola.saldo_final_clp == null) return;
  const day = cartolaClosingDay(cartola);
  const found = cartolaLedgerBalanceAt(accountId, day, frame.anchor.amount_clp, dbHandle);
  if (found !== cartola.saldo_final_clp) {
    throw new CartolaImportRefusal(cartola.period_month, cartola.source_file, "ledger_closing", [balanceProblem("closing", day, cartola.saldo_final_clp, found)]);
  }
}

/**
 * Inside the cartola's transaction, once its plan is applied and its month recorded: the printed
 * balances against the ledger (see the module doc). Throws `CartolaImportRefusal`, which rolls the
 * cartola back. In the frame that derives the anchor, returns the anchor it derived (for the run to
 * carry and write); else null.
 */
export function assertCartolaLedgerAfterApply(
  accountId: number,
  cartola: ParsedCheckingCartola,
  frame: CartolaLedgerFrame,
  dbHandle: Database = db
): CheckingLedgerAnchorAt | null {
  if (frame.kind === "rebuild") return null;
  const derived = getCartolaDerivedAnchor(accountId, dbHandle);
  // No printed closing balance on file yet: nothing derives an anchor and nothing is checked.
  if (frame.kind === "derives_anchor" && derived == null) return null;
  const anchorClp = frame.kind === "established" ? frame.anchor.amount_clp : derived!.amount_clp;
  const problems: string[] = [];
  let reason: CartolaRefusalReason = "ledger_closing";
  if (frame.kind === "derives_anchor" && cartola.saldo_inicial_clp != null) {
    const day = cartolaOpeningDay(cartola);
    const found = cartolaLedgerBalanceAt(accountId, day, anchorClp, dbHandle);
    if (found !== cartola.saldo_inicial_clp) {
      reason = "ledger_opening";
      problems.push(balanceProblem("opening", day, cartola.saldo_inicial_clp, found) + ` (with the anchor this cartola derives, ${anchorClp} CLP)`);
    }
  }
  if (cartola.saldo_final_clp != null) {
    const day = cartolaClosingDay(cartola);
    const found = cartolaLedgerBalanceAt(accountId, day, anchorClp, dbHandle);
    if (found !== cartola.saldo_final_clp) {
      problems.push(
        balanceProblem("closing", day, cartola.saldo_final_clp, found) +
          " once its movements are applied — the month's rows on file do not add up to what the bank lists (a movement written twice, or a row the cartola does not list)"
      );
    }
  }
  if (problems.length === 0 && frame.kind === "established" && derived != null) {
    if (derived.amount_clp !== frame.anchor.amount_clp || derived.occurred_on !== frame.anchor.occurred_on) {
      reason = "anchor_would_move";
      problems.push(
        `once applied, the newest cartola (${derived.period_month}) no longer lands on its closing balance: the anchor would move from ` +
          `${frame.anchor.amount_clp} CLP on ${frame.anchor.occurred_on} to ${derived.amount_clp} CLP on ${derived.occurred_on} ` +
          `(difference ${derived.amount_clp - frame.anchor.amount_clp})`
      );
    }
  }
  if (problems.length > 0) throw new CartolaImportRefusal(cartola.period_month, cartola.source_file, reason, problems);
  return frame.kind === "derives_anchor" ? { amount_clp: derived!.amount_clp, occurred_on: derived!.occurred_on } : null;
}

/**
 * Every cartola month on file against the ledger with the anchor on file: one line per printed
 * opening or closing balance the ledger does not reach (empty: the whole history holds).
 */
export function checkingLedgerMonthsOffTheirCartolas(accountId: number, dbHandle: Database = db): string[] {
  const anchor = storedCheckingLedgerAnchor(accountId, dbHandle);
  const out: string[] = [];
  const months = dbHandle
    .prepare(
      `SELECT period_month, period_from, period_to, saldo_inicial_clp, saldo_final_clp FROM checking_cartola_imports
       WHERE account_id = ? ORDER BY period_month`
    )
    .all(accountId) as (CartolaMonthPeriodRow & { saldo_inicial_clp: number | null; saldo_final_clp: number | null })[];
  for (const m of months) {
    for (const [what, printed, day] of [
      ["opening", m.saldo_inicial_clp, cartolaOpeningDay(m)],
      ["closing", m.saldo_final_clp, cartolaClosingDay(m)],
    ] as const) {
      if (printed == null) continue;
      const found = cartolaLedgerBalanceAt(accountId, day, anchor?.amount_clp ?? 0, dbHandle);
      if (found !== printed) out.push(`${m.period_month} ${balanceProblem(what, day, printed, found)}`);
    }
  }
  return out;
}

type CartolaMonthPeriodRow = { period_month: string; period_from: string | null; period_to: string | null };

/**
 * Racional's movement list (`broker.movements`, decoded from the crawl by ingest) → ledger.
 *
 * Report-first like every other document importer here; `apply` writes. The shapes it
 * produces were taken from the movements Racional trades already have in the ledger, not
 * invented — a buy is a transfer `Racional USD → <equity account>` carrying `units_delta`
 * (movement 11110: SLV 2026-07-01, US$1.346,17, 24,74186066 units), a dividend is the same
 * transfer reversed with no units, and a CLP deposit lands on Racional CLP.
 *
 * **Incremental by design.** The app lists movements newest-first, so the crawl stops at the
 * first row of the last read the server applied (ingest's crawl cursor). Content dedupe is still
 * applied as a safety net: a read sent again must not double-import.
 *
 * **One read never blocks another.** Ingest sends each staged read on its own and keeps the
 * ones that did not apply cleanly for the next run, so a read that cannot be imported (a trade
 * listed without its share count that the ledger does not already hold, an unmapped kind) is
 * reported and fails the step while later reads and their dividends still apply — until
 * 2026-09-27 one unopened row threw in planning and blocked everything behind it every night.
 */
import type {
  BrokerDividend,
  BrokerMovement,
  BrokerMovementsApplyDetails,
  BrokerMovementsPayload,
} from "nw-tracker-contracts";
import { accountIdForEquityTicker, accountsWithEquityTicker } from "./accountEquityTicker.js";
import { chileCalendarAddDays, chileCalendarTodayYmd, chileWallClockAt } from "./chileDate.js";
import { clpCashBalanceLive } from "./clpCashAccounts.js";
import { brokerCleanThrough, recordBrokerCleanRead } from "./brokerReadCoverage.js";
import { db } from "./db.js";
import {
  getMovementDividendDetail,
  upsertMovementDividendDetail,
  type DividendDetailUpsertOutcome,
  type MovementDividendDetailInput,
} from "./movementDividendDetails.js";

type RacionalMovement = BrokerMovement;
type RacionalScrapedDividend = BrokerDividend;

/** Racional's own cash accounts, by the import keys the panel created them with. */
const RACIONAL_CASH_IMPORT_KEYS = {
  clp: "import:panel|kind=clp|key=clp",
  usd: "import:panel|kind=usd|key=usd",
} as const;

function accountIdByImportKey(importKey: string): number {
  const row = db.prepare(`SELECT id FROM accounts WHERE import_key = ?`).get(importKey) as
    | { id: number }
    | undefined;
  if (!row) throw new Error(`No account with import_key "${importKey}"`);
  return row.id;
}

export function racionalCashAccountId(currency: "clp" | "usd"): number {
  return accountIdByImportKey(RACIONAL_CASH_IMPORT_KEYS[currency]);
}

/**
 * The CLP portafolio caja (`brokerage_cash__caja_*` leaf) — where Racional charges portfolio
 * commissions. Exactly one such account, else null (never guess which caja to charge).
 */
export function portfolioCajaClpAccountId(): number | null {
  const rows = db
    .prepare(
      `SELECT a.id FROM accounts a
       JOIN asset_groups g ON g.id = a.asset_group_id
       WHERE g.slug GLOB 'brokerage_cash__caja_*'`
    )
    .all() as { id: number }[];
  return rows.length === 1 ? rows[0]!.id : null;
}

export type RacionalPlannedMovement = {
  source: RacionalMovement;
  /** Null for kinds that are recorded as a single-leg row rather than a transfer. */
  from_account_id: number | null;
  to_account_id: number | null;
  account_id: number | null;
  amount: number;
  currency: "clp" | "usd";
  units_delta: string | null;
  flow_kind: string | null;
  note: string;
  duplicate_of: number | null;
  /**
   * Reported but never written automatically. Cash in and out of Racional has a counterpart on
   * a real bank account (the ledger models it as a checking→Racional transfer, e.g. movement
   * 11373), and that side arrives through the checking importer. Writing this half here would
   * either double-count the checking leg or invent a transfer from an account the feed never
   * names — so these are surfaced for the existing mirror-pairs flow to link instead.
   */
  requires_manual: string | null;
  /**
   * The ledger and the feed DISAGREE about a movement that exists on both sides (same day,
   * same legs, different amount). Unlike `requires_manual`, which is by design for cash legs,
   * a conflict is a data error and fails the import step so it surfaces as a notification —
   * the 2026-09-18 SOXX dividend booked gross from mail (2,75) against the feed's net (2,34)
   * sat as an «ok» log line for four days.
   */
  conflict: string | null;
  /**
   * The movement would have to be WRITTEN, and cannot be: it is incomplete (a trade listed
   * without its share count, a dividend without its paying position — see
   * `RacionalMovement.incomplete`) and no ledger movement already covers it. Fails the whole
   * file: nothing from it is written and the watermark does not move past it.
   */
  blocked: string | null;
};

/**
 * Every ledger transfer on the same day between the same two accounts.
 *
 * Matching a single row by exact amount is not enough, and real data proves it twice: the
 * 2026-03-05 VEA purchase the feed reports as one US$xxx,xx line exists in the ledger as TWO
 * rows (264,35 + 64,04, units summing to the same 4,96893564), while the 2026-03-26 one is
 * recorded as US$xx,xx against the feed's US$54,68. An exact-row check misses both and would
 * happily import a second copy of each. Summing the day instead recognises a split, and any
 * leftover difference becomes a review flag rather than a silent duplicate.
 */
const findTransfersOnDay = db.prepare(
  `SELECT id, amount, units_delta FROM movements
   WHERE occurred_on = ? AND from_account_id = ? AND to_account_id = ? AND currency = ?`
);

/**
 * Map one Racional movement onto the ledger's own shape.
 *
 * Deposits/withdrawals deliberately produce a SINGLE-LEG row on the Racional cash account: the
 * counterpart is a checking-account movement that arrives through its own cartola import, and
 * inventing the transfer here would double-count it. The mirror-pairs tool is what links the
 * two legs afterwards, exactly as it does for every other historical transfer.
 */
export function planRacionalMovement(movement: RacionalMovement): RacionalPlannedMovement {
  const note = [
    `Racional ${movement.title}`,
    movement.order_id ? `orden ${movement.order_id}` : null,
    movement.price != null ? `${movement.units} @ US$${movement.price}` : null,
  ]
    .filter(Boolean)
    .join(" · ");

  const base = {
    source: movement,
    amount: movement.amount,
    currency: movement.currency,
    units_delta: null as string | null,
    flow_kind: null as string | null,
    from_account_id: null as number | null,
    to_account_id: null as number | null,
    account_id: null as number | null,
    note,
    duplicate_of: null as number | null,
    requires_manual: null as string | null,
    conflict: null as string | null,
    blocked: null as string | null,
  };

  // A trade or dividend without its instrument keeps only the leg it knows (Racional cash): the
  // row can still be recognised in the ledger, and is never written (`blocked`).
  const equityAccount = () => (movement.ticker ? accountIdForEquityTicker(movement.ticker) : null);
  switch (movement.kind) {
    case "buy":
      return {
        ...base,
        from_account_id: racionalCashAccountId(movement.currency),
        to_account_id: equityAccount(),
        units_delta: movement.units,
        flow_kind: "stock_buy",
      };
    case "sell":
      return {
        ...base,
        from_account_id: equityAccount(),
        to_account_id: racionalCashAccountId(movement.currency),
        units_delta: movement.units,
        flow_kind: "stock_sell",
      };
    case "dividend":
      // The list row is just "Dividendo" — the paying instrument comes from the API record or
      // the route id. Attributing it to the wrong position would misstate that holding's
      // return, so a dividend without one is never booked against cash alone.
      return {
        ...base,
        from_account_id: equityAccount(),
        to_account_id: racionalCashAccountId(movement.currency),
        flow_kind: "dividend_payout",
      };
    case "interest":
      return {
        ...base,
        account_id: racionalCashAccountId(movement.currency),
        flow_kind: "savings_earnings",
      };
    case "fee": {
      // Racional's monthly comisión is charged to the PORTAFOLIO caja (the app's fee detail says
      // «Distribución por portafolios»), not the Stocks wallet — and it is a P/L cost, so it
      // carries `cash_fee` (nets against interest; never reads as a capital withdrawal).
      if (movement.currency === "clp") {
        const caja = portfolioCajaClpAccountId();
        if (caja == null) {
          return {
            ...base,
            account_id: racionalCashAccountId("clp"),
            amount: -Math.abs(movement.amount),
            flow_kind: "cash_fee",
            requires_manual:
              "no single portafolio caja account to charge the comisión to — route it by hand",
          };
        }
        return {
          ...base,
          account_id: caja,
          amount: -Math.abs(movement.amount),
          flow_kind: "cash_fee",
        };
      }
      // USD single-leg rows are stored positive with direction in flow_kind.
      return {
        ...base,
        account_id: racionalCashAccountId("usd"),
        amount: Math.abs(movement.amount),
        flow_kind: "cash_fee",
      };
    }
    case "deposit":
      return {
        ...base,
        account_id: racionalCashAccountId(movement.currency),
        requires_manual:
          "cash from a bank account — link it to the checking side in /panel/mirror-pairs",
      };
    case "withdrawal":
      return {
        ...base,
        account_id: racionalCashAccountId(movement.currency),
        amount: -Math.abs(movement.amount),
        requires_manual:
          "cash to a bank account — link it to the checking side in /panel/mirror-pairs",
      };
    case "corporate_action":
      throw new Error(
        `Racional «Evento Corporativo» (${movement.occurred_on}, ${movement.title}) has no ` +
          `ledger mapping yet — decide how to model it before importing`
      );
  }
}

/** USD line amounts are exact 2-decimal values; a cent of slack absorbs float noise only. */
const AMOUNT_TOLERANCE = 0.005;

const findSingleLegOnDay = db.prepare(
  `SELECT id, amount FROM movements
   WHERE occurred_on = ? AND account_id = ? AND currency = ?
     AND COALESCE(flow_kind, '') = COALESCE(?, '')`
);

const findOneLegTransfersOnDay = {
  from: db.prepare(
    `SELECT id, amount FROM movements
     WHERE occurred_on = ? AND from_account_id = ? AND currency = ? AND flow_kind = ?`
  ),
  to: db.prepare(
    `SELECT id, amount FROM movements
     WHERE occurred_on = ? AND to_account_id = ? AND currency = ? AND flow_kind = ?`
  ),
};

export function markDuplicates(planned: RacionalPlannedMovement[]): RacionalPlannedMovement[] {
  return planned.map((p) => {
    // A transfer that knows only its Racional cash leg — the paying position of an unopened
    // dividend no API record covered, the instrument of a trade whose title named none — is
    // recognised by that leg alone: exactly one same-day movement of its kind and amount there.
    // The day sum below would add up different positions' movements; several hits are ambiguous.
    if (p.account_id == null && (p.from_account_id == null) !== (p.to_account_id == null)) {
      const [stmt, leg] =
        p.from_account_id != null
          ? [findOneLegTransfersOnDay.from, p.from_account_id]
          : [findOneLegTransfersOnDay.to, p.to_account_id];
      const hits = (
        stmt.all(p.source.occurred_on, leg, p.currency, p.flow_kind) as { id: number; amount: number }[]
      ).filter((r) => Math.abs(Number(r.amount) - p.amount) <= AMOUNT_TOLERANCE);
      return hits.length === 1 ? { ...p, duplicate_of: hits[0]!.id } : p;
    }
    // Single-leg rows (interest, fees): staged files are never archived and re-runs re-plan
    // them, so an exact same-day twin in the ledger is this row already imported.
    if (p.from_account_id == null || p.to_account_id == null) {
      if (p.account_id == null || p.requires_manual != null) return p;
      const existing = findSingleLegOnDay.all(
        p.source.occurred_on,
        p.account_id,
        p.currency,
        p.flow_kind
      ) as { id: number; amount: number }[];
      const twin = existing.find((r) => Math.abs(Number(r.amount) - p.amount) <= AMOUNT_TOLERANCE);
      return twin ? { ...p, duplicate_of: twin.id } : p;
    }
    const existing = findTransfersOnDay.all(
      p.source.occurred_on,
      p.from_account_id,
      p.to_account_id,
      p.currency
    ) as { id: number; amount: number; units_delta: number | null }[];
    if (existing.length === 0) return p;

    const sum = existing.reduce((acc, r) => acc + Number(r.amount ?? 0), 0);
    const ids = existing.map((r) => r.id);
    if (Math.abs(sum - p.amount) <= AMOUNT_TOLERANCE) {
      // Already represented — as one row, or split across several that add up.
      return { ...p, duplicate_of: ids[0]! };
    }
    return {
      ...p,
      conflict:
        `ledger already has ${existing.length} movement(s) on this day between the same accounts ` +
        `totalling ${sum.toFixed(2)} ${p.currency} vs the feed's ${p.amount.toFixed(2)} ` +
        `(movement${ids.length > 1 ? "s" : ""} ${ids.join(", ")}) — reconcile before importing`,
    };
  });
}

const insTransfer = db.prepare(
  `INSERT INTO movements (from_account_id, to_account_id, amount, currency, occurred_on, note, units_delta, flow_kind)
   VALUES (@from_account_id, @to_account_id, @amount, @currency, @occurred_on, @note, @units_delta, @flow_kind)`
);

const insSingleLeg = db.prepare(
  `INSERT INTO movements (account_id, amount, currency, occurred_on, note, flow_kind)
   VALUES (@account_id, @amount, @currency, @occurred_on, @note, @flow_kind)`
);

export type RacionalImportResult = {
  planned: RacionalPlannedMovement[];
  inserted: number;
  duplicates: number;
  /** Dividend breakdowns written from rows the read matched to the dividends API. */
  details: { movement_id: number; outcome: DividendDetailUpsertOutcome }[];
};

/**
 * An incomplete movement is an error only when it would be written: not already in the ledger,
 * and not held back anyway (a conflict, a cash leg left for mirror-pairs).
 */
function blockedReason(p: RacionalPlannedMovement): string | null {
  if (p.source.incomplete == null) return null;
  if (p.duplicate_of != null || p.conflict != null || p.requires_manual != null) return null;
  return (
    `${p.source.incomplete}, and no ledger movement matches it. Book it by hand, or let the ` +
    `next crawl re-open it (it re-lists the row while it is rendered above the cursor)`
  );
}

/** Newest first, matching the app's own ordering. */
function newestFirst(movements: readonly RacionalMovement[]): RacionalMovement[] {
  return [...movements].sort((a, b) => b.occurred_at.localeCompare(a.occurred_at));
}

/**
 * Plan a read's movements (no writes). Duplicate detection runs BEFORE anything is judged
 * incomplete: a trade listed without its share count that the ledger already holds is simply
 * present, and only one that would be written is `blocked`. Throws on a movement that cannot be
 * mapped at all (a corporate event, a ticker no account holds).
 */
export function planRacionalMovements(movements: readonly RacionalMovement[]): RacionalImportResult {
  const planned = markDuplicates(newestFirst(movements).map(planRacionalMovement)).map((p) => ({
    ...p,
    blocked: blockedReason(p),
  }));
  return { planned, inserted: 0, duplicates: planned.filter((p) => p.duplicate_of != null).length, details: [] };
}

/** Chile calendar day of an API instant — the day the list row prints. */
export function racionalDividendChileYmd(executionDate: string): string {
  return chileWallClockAt(new Date(executionDate)).ymd;
}

function dividendDetailInput(
  movementId: number,
  dividend: RacionalScrapedDividend,
  sourceRef: string
): MovementDividendDetailInput {
  return {
    movement_id: movementId,
    gross_amount: dividend.gross,
    withholding_amount: dividend.withholding,
    currency: "usd",
    // Racional's own detail labels the deduction «Withholding tax USA»; no rate is printed.
    withholding_jurisdiction: dividend.withholding > 0 ? "US" : null,
    pay_date: racionalDividendChileYmd(dividend.execution_date),
    broker_event_id: dividend.id,
    source: "racional_api",
    source_ref: sourceRef,
  };
}

/**
 * Write the planned movements, oldest first so the ledger reads chronologically. A dividend row
 * the crawl matched to the dividends API also gets its gross / withholding breakdown — on the
 * row just inserted, or on the ledger row it duplicates (the breakdown is idempotent, so a
 * re-run adds nothing). The watermark is the caller's (`runRacionalImport`): it depends on
 * every file of the run.
 */
export function applyRacionalMovements(result: RacionalImportResult, sourceRef: string): RacionalImportResult {
  const blocked = result.planned.filter((p) => p.blocked != null);
  if (blocked.length > 0) {
    throw new Error(`${sourceRef} has ${blocked.length} movement(s) that cannot be written — it must not be applied`);
  }
  const toWrite = result.planned.filter(
    (p) => p.duplicate_of == null && p.requires_manual == null && p.conflict == null
  );
  const chronological = [...toWrite].reverse();
  const details: RacionalImportResult["details"] = [];

  db.transaction(() => {
    for (const p of chronological) {
      const params = {
        amount: p.amount,
        currency: p.currency,
        occurred_on: p.source.occurred_on,
        note: p.note,
        flow_kind: p.flow_kind,
      };
      let movementId: number;
      if (p.from_account_id != null && p.to_account_id != null) {
        movementId = Number(
          insTransfer.run({
            ...params,
            from_account_id: p.from_account_id,
            to_account_id: p.to_account_id,
            units_delta: p.units_delta,
          }).lastInsertRowid
        );
      } else if (p.account_id != null) {
        movementId = Number(insSingleLeg.run({ ...params, account_id: p.account_id }).lastInsertRowid);
      } else {
        throw new Error(`Planned Racional movement has no accounts: ${p.note}`);
      }
      if (p.source.dividend) {
        const { outcome } = upsertMovementDividendDetail(dividendDetailInput(movementId, p.source.dividend, sourceRef));
        details.push({ movement_id: movementId, outcome });
      }
    }
    for (const p of result.planned) {
      if (p.duplicate_of == null || !p.source.dividend) continue;
      const { outcome } = upsertMovementDividendDetail(dividendDetailInput(p.duplicate_of, p.source.dividend, sourceRef));
      details.push({ movement_id: p.duplicate_of, outcome });
    }
  })();

  return { ...result, inserted: toWrite.length, details };
}

// ---------------------------------------------------------------------------------------------
// Dividend breakdowns from the dividends API file (`dividends-<stamp>.json`)
// ---------------------------------------------------------------------------------------------

/** How far the ledger row may sit from the API's Chile day: the list and the mail date rows the same day. */
const DIVIDEND_MATCH_WINDOW_DAYS = 2;

export type RacionalDividendDetailPlan = {
  dividend: RacionalScrapedDividend;
  chile_ymd: string;
  /** The `dividend_payout` movement the API record describes, when exactly one matches. */
  movement_id: number | null;
  /** Written already (and identical), so applying changes nothing. */
  already_recorded: boolean;
  /** Skipped for a reason that is not an error (interest entries, a ticker held nowhere). */
  skipped: string | null;
  /** No ledger row, or several — a data error that fails the step. */
  conflict: string | null;
};

const findDividendPayouts = db.prepare(
  `SELECT id, amount, occurred_on FROM movements
   WHERE from_account_id = ? AND to_account_id = ? AND currency = 'usd'
     AND flow_kind = 'dividend_payout'
     AND occurred_on BETWEEN ? AND ?
   ORDER BY occurred_on, id`
);

/**
 * Pair each API dividend with the ledger's `dividend_payout` row: same holder → Racional USD
 * legs, the credited net to the cent, on the API's Chile day or within two days of it (the
 * crawl and the mail path both date rows on the Chile day, so the window only absorbs a UTC
 * evening credit). Exactly one match is a plan; none or several is a conflict — a dividend the
 * broker paid that the ledger lacks, or two rows claiming it, must fail the step.
 */
export function planRacionalDividendDetails(
  dividends: readonly RacionalScrapedDividend[],
  sourceRef: string,
  accounts?: { holderFor: (ticker: string) => number[]; racionalUsd: number }
): RacionalDividendDetailPlan[] {
  const holderFor = accounts?.holderFor ?? accountsWithEquityTicker;
  const racionalUsd = accounts?.racionalUsd ?? racionalCashAccountId("usd");
  return dividends.map((dividend) => {
    const chileYmd = racionalDividendChileYmd(dividend.execution_date);
    const base: RacionalDividendDetailPlan = {
      dividend,
      chile_ymd: chileYmd,
      movement_id: null,
      already_recorded: false,
      skipped: null,
      conflict: null,
    };
    if (dividend.is_interest) return { ...base, skipped: "interest entry, not a dividend (booked from the list row)" };
    const holders = holderFor(dividend.asset_id);
    if (holders.length !== 1) {
      return {
        ...base,
        conflict:
          holders.length === 0
            ? `no account holds ${dividend.asset_id} — create the position before importing its dividend`
            : `several accounts hold ${dividend.asset_id}`,
      };
    }
    const from = chileCalendarAddDays(chileYmd, -DIVIDEND_MATCH_WINDOW_DAYS);
    const to = chileCalendarAddDays(chileYmd, DIVIDEND_MATCH_WINDOW_DAYS);
    const rows = findDividendPayouts.all(holders[0]!, racionalUsd, from, to) as {
      id: number;
      amount: number;
      occurred_on: string;
    }[];
    const byAmount = rows.filter((r) => Math.abs(Number(r.amount) - dividend.net) <= AMOUNT_TOLERANCE);
    const sameDay = byAmount.filter((r) => r.occurred_on === chileYmd);
    const candidates = sameDay.length > 0 ? sameDay : byAmount;
    if (candidates.length === 0) {
      return {
        ...base,
        conflict:
          rows.length === 0
            ? `no dividend_payout of ${dividend.asset_id} → Racional USD in the ledger around ${chileYmd}`
            : `ledger dividend(s) of ${dividend.asset_id} around ${chileYmd} read ${rows
                .map((r) => `${r.amount} (movement ${r.id}, ${r.occurred_on})`)
                .join(", ")} but Racional credited ${dividend.net} — reconcile before importing`,
      };
    }
    if (candidates.length > 1) {
      return {
        ...base,
        conflict: `several ledger dividends of ${dividend.asset_id} match ${dividend.net} around ${chileYmd} (movements ${candidates
          .map((r) => r.id)
          .join(", ")})`,
      };
    }
    const movementId = candidates[0]!.id;
    const existing = getMovementDividendDetail(movementId);
    const alreadyRecorded =
      existing != null &&
      existing.source === "racional_api" &&
      existing.broker_event_id === dividend.id &&
      Math.abs(existing.gross_amount - dividend.gross) <= AMOUNT_TOLERANCE &&
      Math.abs(existing.withholding_amount - dividend.withholding) <= AMOUNT_TOLERANCE;
    void sourceRef;
    return { ...base, movement_id: movementId, already_recorded: alreadyRecorded };
  });
}

export function applyRacionalDividendDetails(
  plans: readonly RacionalDividendDetailPlan[],
  sourceRef: string
): { movement_id: number; outcome: DividendDetailUpsertOutcome }[] {
  const out: { movement_id: number; outcome: DividendDetailUpsertOutcome }[] = [];
  db.transaction(() => {
    for (const plan of plans) {
      if (plan.movement_id == null || plan.conflict != null || plan.skipped != null) continue;
      const { outcome } = upsertMovementDividendDetail(dividendDetailInput(plan.movement_id, plan.dividend, sourceRef));
      out.push({ movement_id: plan.movement_id, outcome });
    }
  })();
  return out;
}

/** From this day of the month, a missing comisión row means the crawl should run. */
export const RACIONAL_COMISION_NUDGE_FROM_DAY = 20;

/**
 * Racional charges its portafolio comisión monthly (~the 18th) to the caja — and sends NO
 * e-mail for it, so the mail-driven nudge system can never see it. Calendar rule instead: from
 * the 20th, if the caja still holds money but has no `cash_fee` row this month, the nightly
 * broker-email check names racional for a crawl. Self-limiting: once the fee imports (or the
 * portafolio winds down and the caja empties), the nudge stops.
 */
export function racionalComisionCrawlDue(
  todayYmd = chileCalendarTodayYmd()
): { due: boolean; reason: string | null } {
  const dayOfMonth = Number(todayYmd.slice(8, 10));
  if (dayOfMonth < RACIONAL_COMISION_NUDGE_FROM_DAY) return { due: false, reason: null };
  const caja = portfolioCajaClpAccountId();
  if (caja == null) return { due: false, reason: null };
  if (clpCashBalanceLive(caja).value_clp <= 0) return { due: false, reason: null };
  const monthKey = todayYmd.slice(0, 7);
  const hasFee = db
    .prepare(
      `SELECT 1 FROM movements
       WHERE account_id = ? AND flow_kind = 'cash_fee' AND substr(occurred_on, 1, 7) = ?
       LIMIT 1`
    )
    .get(caja, monthKey);
  if (hasFee) return { due: false, reason: null };
  return {
    due: true,
    reason: `no portafolio comisión recorded for ${monthKey} on the caja (account ${caja})`,
  };
}


// ---------------------------------------------------------------------------------------------
// One read of Racional (`broker.movements`)
// ---------------------------------------------------------------------------------------------

function plannedLegs(p: RacionalPlannedMovement): string {
  if (p.from_account_id == null && p.to_account_id == null) return `account ${p.account_id}`;
  return `${p.from_account_id ?? "?"} → ${p.to_account_id ?? "?"}`;
}

function movementState(p: RacionalPlannedMovement): { state: string; detail: string | null } {
  if (p.blocked) return { state: "blocked", detail: p.blocked };
  if (p.conflict) return { state: "conflict", detail: p.conflict };
  if (p.duplicate_of != null) return { state: "duplicate", detail: `already in the ledger as movement ${p.duplicate_of}` };
  if (p.requires_manual) return { state: "manual", detail: p.requires_manual };
  const breakdown = p.source.dividend
    ? `gross ${p.source.dividend.gross.toFixed(2)} − tax ${p.source.dividend.withholding.toFixed(2)}`
    : null;
  return { state: "new", detail: breakdown };
}

/**
 * Plan — and with `apply`, write — one read: its movements (all or nothing: one that must be
 * written and cannot be blocks the list), then its dividends record (each API dividend paired
 * with its ledger row; the gross / withholding breakdown written). A read applied with nothing
 * to fix, the list included, moves the coverage forward to its `read_at`.
 */
export function applyRacionalRead(payload: BrokerMovementsPayload, sourceRef: string): BrokerMovementsApplyDetails {
  const problems: string[] = [];
  const out: BrokerMovementsApplyDetails = {
    applied: payload.apply,
    movements: [],
    movements_blocked: false,
    inserted: 0,
    duplicates: 0,
    dividends: [],
    breakdowns_written: 0,
    problems,
    clean: false,
    clean_through: null,
  };

  if (payload.movements != null) {
    let planned: RacionalImportResult | null = null;
    try {
      planned = planRacionalMovements(payload.movements);
    } catch (err) {
      problems.push(`movement list not imported: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (planned) {
      for (const p of planned.planned) {
        const { state, detail } = movementState(p);
        out.movements.push({
          occurred_on: p.source.occurred_on,
          kind: p.source.kind,
          amount: p.amount,
          currency: p.currency,
          legs: plannedLegs(p),
          units: p.units_delta,
          state,
          detail,
        });
        const what = `${p.source.occurred_on} ${p.source.kind} ${p.amount} ${p.currency}`;
        if (p.conflict) problems.push(`${what} — ${p.conflict}`);
        if (p.blocked) problems.push(`${what} «${p.source.title}» — ${p.blocked}`);
      }
      out.movements_blocked = planned.planned.some((p) => p.blocked != null);
      out.duplicates = planned.duplicates;
      if (payload.apply && !out.movements_blocked) {
        const result = applyRacionalMovements(planned, sourceRef);
        out.inserted = result.inserted;
        out.breakdowns_written += result.details.filter((d) => d.outcome !== "unchanged").length;
      }
    }
  }

  if (payload.dividends != null) {
    const plans = planRacionalDividendDetails(payload.dividends, sourceRef);
    for (const plan of plans) {
      const d = plan.dividend;
      out.dividends.push({
        chile_ymd: plan.chile_ymd,
        asset_id: d.asset_id,
        gross: d.gross,
        withholding: d.withholding,
        net: d.net,
        state: plan.skipped ? "skipped" : plan.conflict ? "conflict" : plan.already_recorded ? "recorded" : "new",
        movement_id: plan.movement_id,
        detail: plan.skipped ?? plan.conflict ?? null,
      });
      if (plan.conflict) problems.push(`dividend ${plan.chile_ymd} ${d.asset_id} net ${d.net.toFixed(2)} usd — ${plan.conflict}`);
    }
    if (payload.apply) {
      out.breakdowns_written += applyRacionalDividendDetails(plans, sourceRef).filter((w) => w.outcome !== "unchanged").length;
    }
  }

  // Coverage comes from a read of the list only: the dividends record alone says nothing about
  // movements the notifications announced.
  out.clean = problems.length === 0 && payload.movements != null;
  if (payload.apply && out.clean) recordBrokerCleanRead("racional", payload.read_at);
  out.clean_through = brokerCleanThrough("racional");
  return out;
}

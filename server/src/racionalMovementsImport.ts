/**
 * Import Racional movements into the ledger.
 *
 * Report-first like every other document importer here; `--apply` writes. The shapes it
 * produces were taken from the movements Racional trades already have in the ledger, not
 * invented — a buy is a transfer `Racional USD → <equity account>` carrying `units_delta`
 * (movement 11110: SLV 2026-07-01, US$1.346,17, 24,74186066 units), a dividend is the same
 * transfer reversed with no units, and a CLP deposit lands on Racional CLP.
 *
 * **Incremental by design.** The app lists movements newest-first, so the fetcher crawls only
 * until it meets the last movement this importer recorded; the watermark below is the contract
 * between the two. Content dedupe is still applied as a safety net, because a re-run of the
 * same staged file must not double-import.
 */
import fs from "node:fs";
import path from "node:path";
import { accountIdForEquityTicker } from "./accountEquityTicker.js";
import { chileCalendarTodayYmd } from "./chileDate.js";
import { clpCashBalanceLive } from "./clpCashAccounts.js";
import { db } from "./db.js";
import { resolveCfraserCsvDir } from "./cfraserPaths.js";
import {
  racionalRowToMovement,
  sortRacionalMovementsNewestFirst,
  type RacionalMovement,
  type RacionalScrapedRow,
} from "./racionalMovements.js";

/** Where `scraper/` stages fetched movement files. */
export function resolveRacionalMovementsDir(): string {
  return path.join(resolveCfraserCsvDir(), "racional-movements");
}

/**
 * Crawl watermark, shared with the fetcher (which has no DB access by design — Playwright must
 * stay out of the server's dependency tree). The fetcher stops scrolling when it reaches this
 * movement; this importer advances it only after a successful write.
 */
export function resolveRacionalStatePath(): string {
  return path.join(resolveCfraserCsvDir(), ".racional-import-state.json");
}

export type RacionalImportState = {
  last_movement_id: string | null;
  last_occurred_at: string | null;
  updated_at: string;
};

export function readRacionalImportState(): RacionalImportState | null {
  const file = resolveRacionalStatePath();
  if (!fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as RacionalImportState;
  } catch {
    return null;
  }
}

export function writeRacionalImportState(movement: RacionalMovement, nowIso: string): void {
  const state: RacionalImportState = {
    last_movement_id: movement.movement_id,
    last_occurred_at: movement.occurred_at,
    updated_at: nowIso,
  };
  fs.writeFileSync(resolveRacionalStatePath(), `${JSON.stringify(state, null, 2)}\n`);
}

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
    `Racional ${movement.raw_title}`,
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
  };

  switch (movement.kind) {
    case "buy": {
      const cash = racionalCashAccountId(movement.currency);
      const equity = accountIdForEquityTicker(movement.ticker!);
      return {
        ...base,
        from_account_id: cash,
        to_account_id: equity,
        units_delta: movement.units,
        flow_kind: "stock_buy",
      };
    }
    case "sell": {
      const cash = racionalCashAccountId(movement.currency);
      const equity = accountIdForEquityTicker(movement.ticker!);
      return {
        ...base,
        from_account_id: equity,
        to_account_id: cash,
        units_delta: movement.units,
        flow_kind: "stock_sell",
      };
    }
    case "dividend": {
      // The list row is just "Dividendo" — the paying instrument only appears in the detail
      // view. Attributing it to the wrong position would misstate that holding's return, so a
      // dividend without a ticker is refused rather than booked against cash alone.
      if (!movement.ticker) {
        throw new Error(
          `Racional dividend on ${movement.occurred_on} (${movement.amount} ${movement.currency}) ` +
            `has no instrument — fetch its detail view so the paying position is known`
        );
      }
      return {
        ...base,
        from_account_id: accountIdForEquityTicker(movement.ticker),
        to_account_id: racionalCashAccountId(movement.currency),
        flow_kind: "dividend_payout",
      };
    }
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
        `Racional «Evento Corporativo» (${movement.occurred_on}, ${movement.raw_title}) has no ` +
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

export function markDuplicates(planned: RacionalPlannedMovement[]): RacionalPlannedMovement[] {
  return planned.map((p) => {
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
      requires_manual:
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
  file: string;
  parsed: number;
  planned: RacionalPlannedMovement[];
  inserted: number;
  duplicates: number;
};

/** Parse a staged file into planned movements (no writes). */
export function planRacionalMovementsFile(file: string): RacionalImportResult {
  const rows = JSON.parse(fs.readFileSync(file, "utf8")) as RacionalScrapedRow[];
  const movements = sortRacionalMovementsNewestFirst(rows.map(racionalRowToMovement));
  const planned = markDuplicates(movements.map(planRacionalMovement));
  return {
    file: path.basename(file),
    parsed: movements.length,
    planned,
    inserted: 0,
    duplicates: planned.filter((p) => p.duplicate_of != null).length,
  };
}

/**
 * Write the planned movements, oldest first so the ledger reads chronologically, then advance
 * the watermark to the newest one actually recorded.
 */
export function applyRacionalMovements(
  result: RacionalImportResult,
  nowIso: string
): RacionalImportResult {
  const toWrite = result.planned.filter((p) => p.duplicate_of == null && p.requires_manual == null);
  const chronological = [...toWrite].reverse();

  db.transaction(() => {
    for (const p of chronological) {
      const params = {
        amount: p.amount,
        currency: p.currency,
        occurred_on: p.source.occurred_on,
        note: p.note,
        flow_kind: p.flow_kind,
      };
      if (p.from_account_id != null && p.to_account_id != null) {
        insTransfer.run({
          ...params,
          from_account_id: p.from_account_id,
          to_account_id: p.to_account_id,
          units_delta: p.units_delta,
        });
      } else if (p.account_id != null) {
        insSingleLeg.run({ ...params, account_id: p.account_id });
      } else {
        throw new Error(`Planned Racional movement has no accounts: ${p.note}`);
      }
    }
  })();

  // Watermark from the newest movement in the file, whether or not it was a duplicate: the
  // crawl has provably covered everything up to it.
  const newest = result.planned[0];
  if (newest) writeRacionalImportState(newest.source, nowIso);

  return { ...result, inserted: toWrite.length };
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

export function listRacionalMovementFiles(dir = resolveRacionalMovementsDir()): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((n) => /^movements-.*\.json$/.test(n))
    .sort()
    .map((n) => path.join(dir, n));
}

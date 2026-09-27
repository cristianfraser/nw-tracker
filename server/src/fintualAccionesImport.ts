/**
 * Fintual «Acciones» documents → dividend breakdowns (`movement_dividend_details`).
 *
 * The ledger already holds every Fintual dividend as a `dividend_payout` transfer (equity →
 * Fintual USD) booked from the notification mail or the certificado CSV at the NET amount the
 * account received. What those sources never carry is the gross and the US withholding, and
 * that is what the Alpaca monthly cartola and the on-request certificado de eventos de capital
 * print. This importer pairs each printed dividend with its ledger row and writes the breakdown;
 * it never creates or changes a movement.
 *
 * Pairing: same instrument (the ticker's one account) → Fintual USD, the printed NET to the
 * cent, within ±5 days of the printed date — the same window the e-mail and certificado
 * imports use, because a reinvested dividend is dated on its DRIP day up to five days after
 * the payment (SPY 07/31 → 08-05). A printed dividend with no ledger row, or with several, is a
 * CONFLICT that fails the step: a dividend the broker paid and the ledger lacks is exactly what
 * must not pass as an ok log line. Sweep interest is reported, not booked.
 */
import fs from "node:fs";
import path from "node:path";
import { accountsWithEquityTicker } from "./accountEquityTicker.js";
import { chileCalendarAddDays } from "./chileDate.js";
import { db } from "./db.js";
import { resolveCfraserCsvDir } from "./cfraserPaths.js";
import {
  parseAlpacaMonthlyStatementText,
  parseFintualAccionesCertificadoText,
  pdfLayoutText,
  type AlpacaCashInterest,
} from "./fintualAccionesDocs.js";
import {
  DIVIDEND_DETAIL_SOURCE_RANK,
  getMovementDividendDetail,
  upsertMovementDividendDetail,
  type DividendDetailUpsertOutcome,
  type MovementDividendDetailInput,
} from "./movementDividendDetails.js";

export const FINTUAL_USD_IMPORT_KEY = "import:panel|kind=usd|key=fintual_usd";

/** Payment date ↔ DRIP-day skew, the window every Fintual dividend source shares. */
export const FINTUAL_DIVIDEND_MATCH_WINDOW_DAYS = 5;

/** Each printed amount is rounded to the cent; gross − tax and the ledger's net can differ by one. */
const AMOUNT_TOLERANCE = 0.015;

export function resolveFintualAccionesDir(): string {
  return path.join(resolveCfraserCsvDir(), "fintual-acciones");
}

export function listFintualAccionesFiles(root = resolveFintualAccionesDir()): {
  cartolas: string[];
  certificados: string[];
} {
  const list = (sub: string): string[] => {
    const dir = path.join(root, sub);
    if (!fs.existsSync(dir)) return [];
    return fs
      .readdirSync(dir)
      .filter((n) => n.toLowerCase().endsWith(".pdf"))
      .sort()
      .map((n) => path.join(dir, n));
  };
  return { cartolas: list("cartolas"), certificados: list("certificados") };
}

export function fintualUsdAccountId(): number {
  const row = db.prepare(`SELECT id FROM accounts WHERE import_key = ?`).get(FINTUAL_USD_IMPORT_KEY) as
    | { id: number }
    | undefined;
  if (!row) throw new Error(`No account with import_key "${FINTUAL_USD_IMPORT_KEY}"`);
  return row.id;
}

/** One dividend as a document prints it, whichever document. */
export type PrintedDividend = {
  date: string;
  symbol: string;
  gross: number;
  withholding: number;
  net: number;
  per_share?: number | null;
  position_qty?: number | null;
  record_date?: string | null;
  withholding_rate_pct?: number | null;
  tax_country?: string | null;
};

export type FintualDividendDetailPlan = {
  printed: PrintedDividend;
  source: "fintual_cartola" | "fintual_certificado";
  source_ref: string;
  /** The `dividend_payout` movement the printed dividend describes, when exactly one matches. */
  movement_id: number | null;
  already_recorded: boolean;
  conflict: string | null;
};

const findDividendPayouts = db.prepare(
  `SELECT id, amount, occurred_on FROM movements
   WHERE from_account_id = ? AND to_account_id = ? AND currency = 'usd'
     AND flow_kind = 'dividend_payout'
     AND occurred_on BETWEEN ? AND ?
   ORDER BY occurred_on, id`
);

function detailInput(movementId: number, plan: FintualDividendDetailPlan): MovementDividendDetailInput {
  const p = plan.printed;
  return {
    movement_id: movementId,
    gross_amount: p.gross,
    withholding_amount: p.withholding,
    currency: "usd",
    withholding_rate_pct: p.withholding_rate_pct ?? null,
    // Alpaca's «NRA Withheld» is IRS nonresident-alien withholding; the certificado only says
    // «impuestos», so the jurisdiction is recorded only where the document names it.
    withholding_jurisdiction: plan.source === "fintual_cartola" && p.withholding > 0 ? "US" : null,
    tax_residency_country: p.tax_country ?? null,
    per_share_amount: p.per_share ?? null,
    position_qty: p.position_qty ?? null,
    record_date: p.record_date ?? null,
    pay_date: p.date,
    broker_event_id: null,
    source: plan.source,
    source_ref: plan.source_ref,
  };
}

export function planFintualDividendDetails(
  printed: readonly PrintedDividend[],
  source: FintualDividendDetailPlan["source"],
  sourceRef: string,
  accounts?: { holderFor: (ticker: string) => number[]; fintualUsd: number }
): FintualDividendDetailPlan[] {
  const holderFor = accounts?.holderFor ?? accountsWithEquityTicker;
  const fintualUsd = accounts?.fintualUsd ?? fintualUsdAccountId();
  return printed.map((p) => {
    const base: FintualDividendDetailPlan = {
      printed: p,
      source,
      source_ref: sourceRef,
      movement_id: null,
      already_recorded: false,
      conflict: null,
    };
    const holders = holderFor(p.symbol);
    if (holders.length !== 1) {
      return {
        ...base,
        conflict:
          holders.length === 0
            ? `no account holds ${p.symbol} — create the position before importing its dividend`
            : `several accounts hold ${p.symbol}`,
      };
    }
    const from = chileCalendarAddDays(p.date, -FINTUAL_DIVIDEND_MATCH_WINDOW_DAYS);
    const to = chileCalendarAddDays(p.date, FINTUAL_DIVIDEND_MATCH_WINDOW_DAYS);
    const rows = findDividendPayouts.all(holders[0]!, fintualUsd, from, to) as {
      id: number;
      amount: number;
      occurred_on: string;
    }[];
    const byAmount = rows.filter((r) => Math.abs(Number(r.amount) - p.net) <= AMOUNT_TOLERANCE);
    const sameDay = byAmount.filter((r) => r.occurred_on === p.date);
    const candidates = sameDay.length > 0 ? sameDay : byAmount;
    if (candidates.length === 0) {
      return {
        ...base,
        conflict:
          rows.length === 0
            ? `no dividend_payout of ${p.symbol} → Fintual USD in the ledger within ±${FINTUAL_DIVIDEND_MATCH_WINDOW_DAYS} days of ${p.date}`
            : `ledger dividend(s) of ${p.symbol} near ${p.date} read ${rows
                .map((r) => `${r.amount} (movement ${r.id}, ${r.occurred_on})`)
                .join(", ")} but the document prints net ${p.net} — reconcile before importing`,
      };
    }
    if (candidates.length > 1) {
      return {
        ...base,
        conflict: `several ledger dividends of ${p.symbol} match ${p.net} near ${p.date} (movements ${candidates
          .map((r) => r.id)
          .join(", ")})`,
      };
    }
    const movementId = candidates[0]!.id;
    // Recorded already when the same amounts stand from this document class or a better one —
    // the writer would leave such a row alone (a second certificado is provenance only), so
    // the report says so instead of promising a write.
    const existing = getMovementDividendDetail(movementId);
    const alreadyRecorded =
      existing != null &&
      DIVIDEND_DETAIL_SOURCE_RANK[existing.source] >= DIVIDEND_DETAIL_SOURCE_RANK[source] &&
      Math.abs(existing.gross_amount - p.gross) <= AMOUNT_TOLERANCE &&
      Math.abs(existing.withholding_amount - p.withholding) <= AMOUNT_TOLERANCE;
    return { ...base, movement_id: movementId, already_recorded: alreadyRecorded };
  });
}

export type FintualAccionesFilePlan = {
  file: string;
  kind: "cartola" | "certificado";
  /** Statement period (cartola) or issue date (certificado). */
  label: string;
  plans: FintualDividendDetailPlan[];
  /** Sweep interest lines (cartola only) — reported, never booked here. */
  interest: AlpacaCashInterest[];
};

export function planFintualAccionesFile(
  file: string,
  kind: FintualAccionesFilePlan["kind"],
  accounts?: { holderFor: (ticker: string) => number[]; fintualUsd: number }
): FintualAccionesFilePlan {
  const name = path.basename(file);
  const text = pdfLayoutText(file);
  if (kind === "cartola") {
    const statement = parseAlpacaMonthlyStatementText(text);
    const printed: PrintedDividend[] = statement.dividends.map((d) => ({
      date: d.trade_date,
      symbol: d.symbol,
      gross: d.gross,
      withholding: d.withholding,
      net: d.net,
      per_share: d.per_share,
      position_qty: d.position_qty,
      record_date: d.record_date,
      withholding_rate_pct: d.withholding_rate_pct,
      tax_country: d.tax_country,
    }));
    return {
      file: name,
      kind,
      label: statement.period_ym,
      plans: planFintualDividendDetails(printed, "fintual_cartola", name, accounts),
      interest: statement.interest,
    };
  }
  const cert = parseFintualAccionesCertificadoText(text);
  const printed: PrintedDividend[] = cert.dividends.map((d) => ({
    date: d.date,
    symbol: d.symbol,
    gross: d.gross,
    withholding: d.tax,
    net: d.net,
  }));
  return {
    file: name,
    kind,
    label: cert.issued_on,
    plans: planFintualDividendDetails(printed, "fintual_certificado", name, accounts),
    interest: [],
  };
}

export function applyFintualDividendDetails(
  plans: readonly FintualDividendDetailPlan[]
): { movement_id: number; outcome: DividendDetailUpsertOutcome }[] {
  const out: { movement_id: number; outcome: DividendDetailUpsertOutcome }[] = [];
  db.transaction(() => {
    for (const plan of plans) {
      if (plan.movement_id == null || plan.conflict != null) continue;
      const { outcome } = upsertMovementDividendDetail(detailInput(plan.movement_id, plan));
      out.push({ movement_id: plan.movement_id, outcome });
    }
  })();
  return out;
}

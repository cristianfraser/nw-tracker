/**
 * The shape of an AFP account's cuota ledger, from the movements certificate (PARSERS.md
 * «AFP account ledger»): one row per day the fund manager's price became visible, carrying
 * every certificate row bought or sold at that price.
 *
 * - A row's day is the day its valor cuota first shows in the account's display series
 *   (`afpDisplayFrame.ts`): the cuotas enter the ledger on the day their price does, so a
 *   contribution never reads as a gain or loss.
 * - Rows of the same day are netted: a commission's credit and debit cancel; the pesos are those
 *   of the cuota-bearing credits and debits (the money that entered or left the fund).
 * - A withdrawal (retiro) is its own row; its provisions (a debit and a credit of the same
 *   cuotas) cancel and are left out.
 * - A transfer between fund managers is not a ledger row: the caller converts the earlier
 *   fund's cuotas with the transfer's own ratio (`factor`).
 */
import type { PensionMovement } from "nw-tracker-contracts";

export const CONTRIBUTION_CODE = "110101";
export const INSURANCE_CODE = "111138";
export const WITHDRAWAL_CODES: ReadonlySet<string> = new Set(["122774", "122974", "122874"]);
export const WITHDRAWAL_PROVISION_CODES: ReadonlySet<string> = new Set([
  "112777",
  "122776",
  "112877",
  "122876",
  "112977",
  "122976",
]);
export const TRANSFER_CODES: ReadonlySet<string> = new Set(["110710", "120700"]);

const CUOTA_TOLERANCE = 0.005;

export type DatedCertificateRow = PensionMovement & {
  /** The day the row's valor cuota became visible, or null while it has not. */
  day: string | null;
  /** UNO cuotas per cuota of the row's fund (1 for UNO; a transfer's ratio for an earlier AFP). */
  factor: number;
};

export type ShapedLedgerRow = {
  kind: "contribution" | "insurance_contribution" | "adjustment" | "withdrawal";
  periods: string[];
  occurred_on: string;
  pesos: number;
  cuotas: number;
};

export type PendingCertificateRow = { period: string; code: string; pesos: number; cuotas: number; valor_cuota: number };

function signedCuotas(r: PensionMovement): number {
  return r.direction === "credit" ? r.cuotas : -r.cuotas;
}

function signedPesos(r: PensionMovement): number {
  return r.direction === "credit" ? r.pesos : -r.pesos;
}

function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}

export function shapePensionLedgerRows(rows: readonly DatedCertificateRow[]): {
  rows: ShapedLedgerRow[];
  pending: PendingCertificateRow[];
} {
  const transfers = rows.filter((r) => TRANSFER_CODES.has(r.code));
  if (transfers.length > 0) {
    throw new Error(
      `pension: a transfer between fund managers (${transfers.map((t) => `${t.period} ${t.description}`).join(", ")}) — convert the earlier fund's rows and leave the transfer out`
    );
  }
  // A withdrawal's provisions are posted and reversed; they must cancel within their período.
  const provisionNet = new Map<string, number>();
  for (const r of rows.filter((x) => WITHDRAWAL_PROVISION_CODES.has(x.code))) {
    provisionNet.set(r.period, (provisionNet.get(r.period) ?? 0) + signedCuotas(r));
  }
  for (const [period, net] of provisionNet) {
    if (Math.abs(net) >= CUOTA_TOLERANCE) {
      throw new Error(`pension: período ${period}: the withdrawal provisions do not cancel (${net.toFixed(2)} cuotas)`);
    }
  }

  const pending: PendingCertificateRow[] = [];
  const out: ShapedLedgerRow[] = [];
  const byDay = new Map<string, DatedCertificateRow[]>();
  for (const r of rows) {
    if (WITHDRAWAL_PROVISION_CODES.has(r.code)) continue;
    if (r.day == null) {
      if (r.cuotas > 0) pending.push({ period: r.period, code: r.code, pesos: r.pesos, cuotas: r.cuotas, valor_cuota: r.valor_cuota });
      continue;
    }
    if (WITHDRAWAL_CODES.has(r.code)) {
      if (r.direction !== "debit") throw new Error(`pension: período ${r.period}: withdrawal ${r.code} is a credit`);
      out.push({
        kind: "withdrawal",
        periods: [r.period],
        occurred_on: r.day,
        pesos: -r.pesos,
        cuotas: round4(-r.cuotas * r.factor),
      });
      continue;
    }
    const list = byDay.get(r.day) ?? [];
    list.push(r);
    byDay.set(r.day, list);
  }
  for (const [day, list] of byDay) {
    const cuotas = round4(list.reduce((s, r) => s + signedCuotas(r) * r.factor, 0));
    if (Math.abs(cuotas) < CUOTA_TOLERANCE) continue;
    const pesos = list.filter((r) => r.cuotas > 0).reduce((s, r) => s + signedPesos(r), 0);
    const codes = new Set(list.map((r) => r.code));
    const kind = codes.has(CONTRIBUTION_CODE)
      ? "contribution"
      : [...codes].every((c) => c === INSURANCE_CODE)
        ? "insurance_contribution"
        : "adjustment";
    out.push({ kind, periods: [...new Set(list.map((r) => r.period))].sort(), occurred_on: day, pesos, cuotas });
  }
  out.sort((a, b) => a.occurred_on.localeCompare(b.occurred_on) || a.kind.localeCompare(b.kind));
  return { rows: out, pending };
}

/** The ledger note for a row — human provenance only; nothing reads it. */
export function pensionLedgerNote(r: ShapedLedgerRow): string {
  const periods = r.periods.join(", ");
  switch (r.kind) {
    case "contribution":
      return `AFP cotización — período ${periods}`;
    case "insurance_contribution":
      return `AFP abono AFC/SLP — período ${periods}`;
    case "withdrawal":
      return `AFP retiro — período ${periods}`;
    case "adjustment":
      return `AFP reliquidaciones/comisiones netas — período ${periods}`;
  }
}

function addMonths(period: string, months: number): string {
  const [y, m] = period.split("-").map(Number) as [number, number];
  const idx = y * 12 + (m - 1) + months;
  return `${Math.floor(idx / 12)}-${String((idx % 12) + 1).padStart(2, "0")}`;
}

/**
 * Where a row's valor cuota is looked for: from six months before its período to eighteen
 * after. A contribution is credited the month after its período, a late one months later, and
 * an independent worker's are paid through the Tesorería with the next year's tax return (the
 * 2017 honorarios were credited on 2018-05-24, with the insurance-premium adjustments of
 * 2018-06..09 at the same price). Uniqueness (one fund manager, one run) guards the width.
 */
export function certificateRowPriceWindow(period: string): { fromDay: string; beforeDay: string } {
  return { fromDay: `${addMonths(period, -6)}-01`, beforeDay: `${addMonths(period, 18)}-01` };
}

/**
 * The day a valor cuota first shows in a daily series, looking from `fromDay` to before
 * `beforeDay`: the first day of the one run of consecutive days carrying it. Null when the
 * series does not carry it (yet); two separate runs are an ambiguity and throw.
 */
export function firstVisibleDayOfValue(
  series: readonly { day: string; unit_value_clp: number }[],
  valor: number,
  fromDay: string,
  beforeDay: string,
  toleranceClp = 0.005
): string | null {
  let first: string | null = null;
  let runs = 0;
  let inRun = false;
  for (const s of series) {
    if (s.day < fromDay || s.day >= beforeDay) continue;
    const hit = Math.abs(s.unit_value_clp - valor) <= toleranceClp;
    if (hit && !inRun) {
      runs += 1;
      if (first == null) first = s.day;
    }
    inRun = hit;
  }
  if (runs > 1) throw new Error(`pension: valor cuota ${valor} shows in ${runs} separate runs from ${first} — cannot date the row`);
  return first;
}

/**
 * The chain of funds a pension account's movements certificate describes, located against the
 * Superintendencia's official valor cuota (docs/afp-fund-accounts-plan.md).
 *
 * - A certificate row prints its valor cuota but not the fund manager: the value is looked for
 *   in every AFP's official series inside the row's price window (`certificateRowPriceWindow`),
 *   and exactly one AFP must carry it on exactly one run of days (`firstVisibleDayOfValue`).
 *   That names the row's AFP and the official day it was bought or sold at.
 * - A fund switch is a «Traspaso Egreso Cuentas» debit at one AFP followed by a «Traspaso Ingreso
 *   Cuentas» credit at another (`TRANSFER_CODES`), paired in official-day order. Each fund's
 *   non-transfer rows plus the cuotas its switch in credited must net to the cuotas its switch
 *   out sold.
 * - A fund is held from the visible day of its first located row (a contribution, or the
 *   switch in) through the visible day of its switch out: the day its sale price showed
 *   (decision 2 — the sending fund's series ends there, so an on-or-before read keeps the
 *   cuotas at the pesos that left until the receiving fund credits them).
 *
 * Pure: the official series come in as data, so the chain is testable on synthetic rows.
 */
import type { PensionMovement } from "nw-tracker-contracts";
import { afpDisplayDayForOfficialDay } from "./afpDisplayFrame.js";
import { TRANSFER_CODES, certificateRowPriceWindow, firstVisibleDayOfValue } from "./pensionLedgerShape.js";

export type OfficialSeriesByAfp = ReadonlyMap<string, readonly { day: string; unit_value_clp: number }[]>;

export type LocatedCertificateRow = PensionMovement & { afp: string; official_day: string };

/** A switch between two fund managers: the egreso at `from`, the ingreso at `to`. */
export type FundSwitch = {
  from: string;
  to: string;
  out: LocatedCertificateRow;
  in: LocatedCertificateRow;
  /** Cuotas bought per cuota sold. */
  ratio: number;
  /** Pesos the receiving fund credited minus the pesos the sending fund's sale produced. */
  pesos_gap: number;
};

/** One fund of the chain, in holding order. */
export type FundLeg = {
  afp: string;
  /** The switch that brought the money in; null for the first fund. */
  switch_in: FundSwitch | null;
  /** The switch that took the money out; null for the fund still held. */
  switch_out: FundSwitch | null;
  /** The fund's located rows other than its transfers, in official-day order. */
  rows: LocatedCertificateRow[];
  /** Σ signed cuotas of `rows`. */
  net_cuotas: number;
};

export type FundHeldWindow = {
  afp: string;
  /** Visible day of the fund's first located row (its first contribution, or its switch in). */
  from_day: string;
  /** Visible day of the switch out's egreso row; null for the fund still held. */
  through_day: string | null;
};

const CUOTA_TOLERANCE = 0.005;

function signedCuotas(r: PensionMovement): number {
  return r.direction === "credit" ? r.cuotas : -r.cuotas;
}

/**
 * Name each row's AFP and official day. Throws when a row's valor cuota shows in no AFP's
 * series or in several, or when its pesos are not its cuotas at that value (the certificate
 * prints cuotas cut to two decimals, so up to a hundredth of a cuota apart).
 */
export function locateCertificateRows(
  rows: readonly PensionMovement[],
  byAfp: OfficialSeriesByAfp
): LocatedCertificateRow[] {
  return rows.map((r) => {
    const { fromDay, beforeDay } = certificateRowPriceWindow(r.period);
    const hits: { afp: string; day: string }[] = [];
    for (const [afp, series] of byAfp) {
      const day = firstVisibleDayOfValue(series, r.valor_cuota, fromDay, beforeDay);
      if (day) hits.push({ afp, day });
    }
    if (hits.length !== 1) {
      throw new Error(
        `pension chain: row ${r.period} ${r.code} ${r.description} valor ${r.valor_cuota}: ${hits.length === 0 ? "no" : "several"} official matches ${JSON.stringify(hits)}`
      );
    }
    if (r.cuotas > 0 && Math.abs(r.pesos - r.cuotas * r.valor_cuota) > 0.0101 * r.valor_cuota) {
      throw new Error(`pension chain: row ${r.period} ${r.code}: ${r.pesos} pesos ≠ ${r.cuotas} cuotas × ${r.valor_cuota}`);
    }
    return { ...r, afp: hits[0]!.afp, official_day: hits[0]!.day };
  });
}

/** The transfers, in official-day order, paired egreso → ingreso across two fund managers. */
export function pairFundSwitches(located: readonly LocatedCertificateRow[]): FundSwitch[] {
  const transfers = located
    .filter((r) => TRANSFER_CODES.has(r.code))
    .sort((a, b) => a.official_day.localeCompare(b.official_day));
  if (transfers.length % 2 !== 0) {
    throw new Error(`pension chain: ${transfers.length} transfer rows do not pair as egreso → ingreso`);
  }
  const out: FundSwitch[] = [];
  for (let i = 0; i < transfers.length; i += 2) {
    const egreso = transfers[i]!;
    const ingreso = transfers[i + 1]!;
    if (egreso.direction !== "debit" || ingreso.direction !== "credit" || egreso.afp === ingreso.afp) {
      throw new Error(`pension chain: transfers do not pair as out → in: ${JSON.stringify([egreso, ingreso])}`);
    }
    if (egreso.cuotas <= 0 || ingreso.cuotas <= 0) {
      throw new Error(`pension chain: a transfer with no cuotas (${egreso.period} ${egreso.afp} → ${ingreso.afp})`);
    }
    out.push({
      from: egreso.afp,
      to: ingreso.afp,
      out: egreso,
      in: ingreso,
      ratio: ingreso.cuotas / egreso.cuotas,
      pesos_gap: ingreso.pesos - egreso.pesos,
    });
  }
  for (let i = 1; i < out.length; i++) {
    if (out[i]!.from !== out[i - 1]!.to) {
      throw new Error(`pension chain: switch ${out[i]!.from} → ${out[i]!.to} does not leave the fund the previous one entered (${out[i - 1]!.to})`);
    }
  }
  return out;
}

/**
 * The funds in holding order with their own rows, checked: every located row belongs to a fund
 * of the chain, a sold fund's rows plus its switch in net to the cuotas its switch out sold
 * (within 0,005), and no row of a sold fund is priced after its egreso.
 */
export function fundChain(located: readonly LocatedCertificateRow[], switches: readonly FundSwitch[]): FundLeg[] {
  const order: string[] = [];
  if (switches.length > 0) {
    order.push(switches[0]!.from);
    for (const s of switches) order.push(s.to);
  } else {
    const afps = new Set(located.map((r) => r.afp));
    if (afps.size !== 1) throw new Error(`pension chain: no switches but rows at ${[...afps].join(", ")}`);
    order.push([...afps][0]!);
  }
  const known = new Set(order);
  for (const r of located) {
    if (!known.has(r.afp)) throw new Error(`pension chain: row ${r.period} ${r.code} is priced at ${r.afp}, a fund the chain never held`);
  }
  return order.map((afp, i) => {
    const rows = located
      .filter((r) => r.afp === afp && !TRANSFER_CODES.has(r.code))
      .sort((a, b) => a.official_day.localeCompare(b.official_day));
    const switchIn = i === 0 ? null : switches[i - 1]!;
    const switchOut = i < switches.length ? switches[i]! : null;
    const net = rows.reduce((s, r) => s + signedCuotas(r), 0);
    if (switchOut) {
      const inbound = switchIn?.in.cuotas ?? 0;
      if (Math.abs(net + inbound - switchOut.out.cuotas) >= CUOTA_TOLERANCE) {
        throw new Error(
          `pension chain: ${afp}: rows net ${net.toFixed(2)} + ${inbound} transferred in ≠ ${switchOut.out.cuotas} transferred out`
        );
      }
      const late = rows.find((r) => r.official_day > switchOut.out.official_day);
      if (late) throw new Error(`pension chain: ${afp}: a row priced ${late.official_day}, after its transfer out on ${switchOut.out.official_day}`);
    }
    return { afp, switch_in: switchIn, switch_out: switchOut, rows, net_cuotas: net };
  });
}

/** The visible day of a located row: its official day shifted by the display lag. */
export function visibleDayOfRow(r: Pick<LocatedCertificateRow, "official_day">, lagBusinessDays: number): string {
  return afpDisplayDayForOfficialDay(r.official_day, lagBusinessDays);
}

/**
 * The days each fund was held, in the display frame: from the visible day of its earliest
 * located row (ingreso included) through the visible day of its egreso. Throws when a fund's
 * row shows before the day its switch in shows — its series would have to start before the
 * money arrived.
 */
export function fundHeldWindows(legs: readonly FundLeg[], lagBusinessDays: number): FundHeldWindow[] {
  return legs.map((leg) => {
    const days = leg.rows.map((r) => visibleDayOfRow(r, lagBusinessDays));
    if (leg.switch_in) days.push(visibleDayOfRow(leg.switch_in.in, lagBusinessDays));
    if (days.length === 0) throw new Error(`pension chain: ${leg.afp} has no rows`);
    const fromDay = [...days].sort()[0]!;
    if (leg.switch_in) {
      const inDay = visibleDayOfRow(leg.switch_in.in, lagBusinessDays);
      if (fromDay < inDay) throw new Error(`pension chain: ${leg.afp}: a row shows on ${fromDay}, before its switch in on ${inDay}`);
    }
    const throughDay = leg.switch_out ? visibleDayOfRow(leg.switch_out.out, lagBusinessDays) : null;
    if (throughDay != null && throughDay < fromDay) {
      throw new Error(`pension chain: ${leg.afp}: sold on ${throughDay}, before its first row on ${fromDay}`);
    }
    return { afp: leg.afp, from_day: fromDay, through_day: throughDay };
  });
}

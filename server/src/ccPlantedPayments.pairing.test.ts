/**
 * The planted-payment pairing runs on the shared `pairOneToOne` helper (`mutual_unique`) and the
 * shared coin equality. This file keeps the loop it replaced — «the pre-wave-7 rule» — as a
 * reference and feeds both the same randomised candidate sets: identical pairs, identical
 * ambiguity reports.
 */
import { describe, expect, it } from "vitest";
import { dayWithinWindow, addDaysIso, ddMmYyyyFromIso } from "nw-tracker-contracts";
import {
  isPaymentLikeCreditMerchant,
  pairPaymentsWithPlanted,
  plantedPaymentMatchesStatementLine,
  type PlantedPaymentRow,
} from "./ccPlantedPayments.js";
import { MATCH_WINDOWS } from "./matching/windows.js";
import { seededRandom } from "./matching/seededRandom.js";

type Currency = PlantedPaymentRow["currency"];
type Payment = { id: number; currency: Currency; amount: number; date: string };

/** The pre-wave-7 rule: pesos to the unit, dollars to the cent. */
function preWave7SameMoney(currency: string, a: number, b: number): boolean {
  return currency === "usd" ? Math.round(a * 100) === Math.round(b * 100) : Math.round(a) === Math.round(b);
}

/** The pre-wave-7 rule: the loop `replacePlantedPaymentLinesFromImport` carried. */
function preWave7Pairing(payments: readonly Payment[], planted: readonly PlantedPaymentRow[]) {
  const fits = (p: Payment, row: PlantedPaymentRow): boolean => {
    if (p.currency !== row.currency || !preWave7SameMoney(p.currency, p.amount, row.amount)) return false;
    return dayWithinWindow(row.paid_on, p.date, { daysBefore: 0, daysAfter: 5 });
  };
  const plantedFor = payments.map((p) => planted.filter((row) => fits(p, row)));
  const paymentsFor = new Map<number, number>();
  for (const rows of plantedFor) for (const row of rows) paymentsFor.set(row.line_id, (paymentsFor.get(row.line_id) ?? 0) + 1);
  const pairs: [number, number][] = [];
  const ambiguous: [number, number[]][] = [];
  payments.forEach((p, i) => {
    const rows = plantedFor[i]!;
    if (rows.length === 0) return;
    if (rows.length > 1 || paymentsFor.get(rows[0]!.line_id) !== 1) {
      ambiguous.push([p.id, rows.map((r) => r.line_id)]);
      return;
    }
    pairs.push([p.id, rows[0]!.line_id]);
  });
  return { pairs, ambiguous };
}

function preWave7MatchesStatementLine(
  planted: PlantedPaymentRow,
  stmt: { merchant: string | null; iso: string | null; amount_clp: number | null; amount_usd: number | null },
  stmtCurrency: string
): boolean {
  if (stmtCurrency !== planted.currency || !isPaymentLikeCreditMerchant(stmt.merchant)) return false;
  const raw = planted.currency === "usd" ? stmt.amount_usd : stmt.amount_clp;
  if (raw == null || raw >= 0 || !preWave7SameMoney(planted.currency, -raw, planted.amount)) return false;
  if (!stmt.iso) return false;
  return dayWithinWindow(planted.paid_on, stmt.iso, { daysBefore: 0, daysAfter: 5 });
}

const DAY0 = "2031-03-01";
const PESOS_CODE: Currency = "clp";
const BOTH: Currency[] = [PESOS_CODE, "usd"];
const PESOS = [150000, 150001, 480000];
const DOLLARS = [100, 100.01, 250.5];

function randomAmount(r: ReturnType<typeof seededRandom>, currency: string): number {
  // Dollars may carry sub-cent noise (a float from a sum); pesos a stray fraction.
  if (currency === "usd") return r.pick(DOLLARS) + (r.chance(0.2) ? r.pick([0.004, -0.004, 0.006]) : 0);
  return r.pick(PESOS) + (r.chance(0.1) ? r.pick([0.4, -0.4]) : 0);
}

describe("planted payments: pairOneToOne reproduces the pre-wave-7 rule", () => {
  it("the window is still the planted day to five days later", () => {
    expect(MATCH_WINDOWS.planted_payment).toMatchObject({ daysBefore: 0, daysAfter: 5 });
  });

  it("600 random imports: same pairs, same ambiguity reports", () => {
    const r = seededRandom(20261115);
    let paired = 0;
    let reported = 0;
    for (let n = 0; n < 600; n++) {
      const currencies: Currency[] = r.chance(0.3) ? [PESOS_CODE] : BOTH;
      const planted: PlantedPaymentRow[] = Array.from({ length: r.int(0, 4) }, (_, i) => {
        const currency = r.pick(currencies);
        return {
          line_id: 100 + i,
          account_id: 1,
          source: "cc_manual_payment" as const,
          currency,
          amount: randomAmount(r, currency),
          paid_on: addDaysIso(DAY0, r.int(0, 8)),
        };
      });
      const payments: Payment[] = Array.from({ length: r.int(0, 5) }, (_, i) => {
        const currency = r.pick(currencies);
        // Days −2…+15 around the planted days: before the planted day, on both window edges, past it.
        return { id: i, currency, amount: randomAmount(r, currency), date: addDaysIso(DAY0, r.int(-2, 15)) };
      });
      // Twins: a payment listed twice, a planted line planted twice.
      if (payments.length > 0 && r.chance(0.25)) payments.push({ ...r.pick(payments), id: payments.length });
      if (planted.length > 0 && r.chance(0.25)) planted.push({ ...r.pick(planted), line_id: 100 + planted.length });

      const want = preWave7Pairing(payments, planted);
      const got = pairPaymentsWithPlanted(payments, planted);
      expect(got.pairs.map((x) => [x.payment.id, x.planted.line_id]), `case ${n}`).toEqual(want.pairs);
      expect(got.ambiguous.map((x) => [x.payment.id, x.planted.map((p) => p.line_id)]), `case ${n}`).toEqual(want.ambiguous);
      paired += want.pairs.length;
      reported += want.ambiguous.length;
    }
    // The generator reaches both outcomes often enough to mean something.
    expect(paired).toBeGreaterThan(50);
    expect(reported).toBeGreaterThan(50);
  });

  it("2000 random statement lines: the reconcile's test answers as before", () => {
    const r = seededRandom(424242);
    let yes = 0;
    for (let n = 0; n < 2000; n++) {
      const currency = r.pick(BOTH);
      const planted: PlantedPaymentRow = {
        line_id: 1,
        account_id: 1,
        source: "cc_santander_receipt",
        currency,
        amount: randomAmount(r, currency),
        paid_on: addDaysIso(DAY0, 3),
      };
      const stmtCurrency = r.chance(0.85) ? currency : r.pick(BOTH);
      const iso = r.chance(0.05) ? null : addDaysIso(DAY0, r.int(0, 11));
      const signed = (r.chance(0.9) ? -1 : 1) * randomAmount(r, stmtCurrency);
      const stmt = {
        merchant: r.pick(["PAGO", "MONTO CANCELADO", "ABONO DE DIVISAS", "PAGO EN SUCURSAL", "SUPERMERCADO", null]),
        amount_clp: stmtCurrency === "usd" ? (r.chance(0.5) ? 0 : null) : signed,
        amount_usd: stmtCurrency === "usd" ? signed : null,
      };
      const want = preWave7MatchesStatementLine(planted, { ...stmt, iso }, stmtCurrency);
      // The date sits in either column, as a statement prints it.
      const printed = iso ? ddMmYyyyFromIso(iso) : null;
      const inPosting = r.chance(0.3);
      const got = plantedPaymentMatchesStatementLine(
        planted,
        {
          merchant: stmt.merchant,
          amount: signed,
          currency: stmtCurrency,
          transaction_date: inPosting ? null : printed,
          posting_date: inPosting ? printed : null,
        }
      );
      expect(got, `case ${n}`).toBe(want);
      if (want) yes += 1;
    }
    expect(yes).toBeGreaterThan(50);
  });
});

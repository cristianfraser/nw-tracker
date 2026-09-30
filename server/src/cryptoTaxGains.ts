/**
 * A year's crypto gain as the SII taxes it for a persona natural (art. 17 N°8 m), IGC only,
 * Formulario 22 code 1032; a net loss goes to code 169):
 * - cost = what each purchase cost, less its commission (Oficio 2208/2022; see
 *   `cryptoTaxLotEvents`), «reajustado de acuerdo al porcentaje de variación experimentado por el
 *   índice de precios al consumidor entre el mes anterior a la adquisición y el mes anterior al de
 *   la enajenación» — the official IPC (`ipc_official_monthly`);
 * - lots: identify the units sold when possible, otherwise weighted average cost (Oficio 979/2022,
 *   2208/2022) — an exchange wallet cannot identify units, so `average` is the default;
 * - the result «reajustado por variación del IPC a diciembre» (Guía Práctica Renta): from the month
 *   before the sale to November, the SII's year-end factors (Circular 5/2026: January 2025 3,6%,
 *   December 0,0%), never negative.
 * The SII prints its percentages with one decimal; `roundPct` (default true) does the same.
 */
import { loadCryptoTaxLotEvents, type CryptoFeePolicy } from "./cryptoTaxLotEvents.js";
import { loadCryptoCoinAccountIdsFundedByBuda } from "./budaWallet.js";
import { db } from "./db.js";
import { monthBeforeYmd } from "./foreignShareTaxGains.js";
import { loadOfficialIpcLookup, officialIpcVariationPctBetween } from "./siiOfficialIpc.js";
import { realizeTaxLots, type TaxLotMethod } from "./taxLots.js";

export type CryptoSaleTaxResult = {
  accountId: number;
  coin: string;
  date: string;
  movementId: number;
  units: number;
  proceedsClp: number;
  costClp: number;
  costReajustadoClp: number;
  gainClp: number;
  decemberPct: number;
  gainDecemberClp: number;
};

export type CryptoYearTaxResult = {
  incomeYear: number;
  method: TaxLotMethod;
  feePolicy: CryptoFeePolicy;
  sales: CryptoSaleTaxResult[];
  proceedsClp: number;
  /** Net result reajustado to December; positive → code 1032, negative → code 169. */
  gainDecemberClp: number;
};

const round1 = (x: number) => Math.round(x * 10) / 10;

export function cryptoTaxGainsForYear(
  incomeYear: number,
  opts: { method?: TaxLotMethod; feePolicy?: CryptoFeePolicy; roundPct?: boolean } = {}
): CryptoYearTaxResult {
  const method = opts.method ?? "average";
  const feePolicy = opts.feePolicy ?? "excluded";
  const roundPct = opts.roundPct ?? true;
  const ipc = loadOfficialIpcLookup();
  const pct = (from: string, to: string) => {
    const p = officialIpcVariationPctBetween(from, to, ipc);
    return roundPct ? round1(p) : p;
  };
  const november = `${incomeYear}-11-01`;
  const sales: CryptoSaleTaxResult[] = [];
  for (const accountId of [...loadCryptoCoinAccountIdsFundedByBuda()].sort((a, b) => a - b)) {
    const coin = (db.prepare(`SELECT equity_ticker FROM accounts WHERE id = ?`).get(accountId) as { equity_ticker: string })
      .equity_ticker;
    for (const d of realizeTaxLots(loadCryptoTaxLotEvents(accountId, feePolicy), method).disposals) {
      if (!d.date.startsWith(`${incomeYear}-`)) continue;
      const saleMonthBefore = monthBeforeYmd(d.date);
      const costReajustado = d.slices.reduce(
        (s, x) => s + x.cost * (1 + pct(monthBeforeYmd(x.acquiredOn), saleMonthBefore) / 100),
        0
      );
      const gain = d.proceeds - costReajustado;
      const decemberPct = Math.max(0, saleMonthBefore > november ? 0 : pct(saleMonthBefore, november));
      sales.push({
        accountId,
        coin,
        date: d.date,
        movementId: d.movementId,
        units: d.units,
        proceedsClp: d.proceeds,
        costClp: d.cost,
        costReajustadoClp: costReajustado,
        gainClp: gain,
        decemberPct,
        gainDecemberClp: gain * (1 + decemberPct / 100),
      });
    }
  }
  sales.sort((a, b) => a.date.localeCompare(b.date) || a.movementId - b.movementId);
  return {
    incomeYear,
    method,
    feePolicy,
    sales,
    proceedsClp: sales.reduce((s, x) => s + x.proceedsClp, 0),
    gainDecemberClp: sales.reduce((s, x) => s + x.gainDecemberClp, 0),
  };
}

/**
 * The pesos a US payslip's dollars are shown at: the `fx_daily` USD/CLP mid on or before its pay
 * date. A US pay stub carries no peso figure of its own (unlike the Chilean USD contract's rebuilt
 * payslips, which store the peso breakdown they were paid at), so every peso view of it — the
 * gross-vs-net breakdown, the income table, the payroll deductions as gastos — reads this one rate.
 */
import { storedPairRate } from "./rates.js";

export function usPayslipClpPerUsd(payDate: string, payslipId: number): number {
  const fx = storedPairRate("usd", "clp", payDate);
  if (!fx || !(fx.mid > 0)) throw new Error(`payslip ${payslipId}: no USD/CLP rate on or before its pay date ${payDate}`);
  return fx.mid;
}

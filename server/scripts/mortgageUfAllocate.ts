/**
 * UF-denominated fixed-rate mortgage: split one installment into interest (on balance),
 * fixed insurance legs (UF/month), and principal (remainder).
 * Payment date is arbitrary (e.g. delayed to a better UF day); only balance and rate matter for interest.
 */

export type MortgageAllocInput = {
  balanceUfBefore: number;
  annualRate: number;
  desgravamenUf: number;
  incendioUf: number;
  /** Total UF actually paid this time (cuota total in UF, including insurances if they are part of the transfer). */
  totalUfPaid: number;
  /** Optional: contractual minimum P+I in UF for this month (warn if paid UF minus insurances falls short). */
  minDividendUf?: number | null;
};

export type MortgageAllocResult = {
  interestUf: number;
  desgravamenUf: number;
  incendioUf: number;
  insuranceUf: number;
  principalUf: number;
  balanceUfAfter: number;
  warnings: string[];
};

export function allocateUfMortgagePayment(input: MortgageAllocInput): MortgageAllocResult {
  const warnings: string[] = [];
  const des = Math.max(0, input.desgravamenUf);
  const inc = Math.max(0, input.incendioUf);
  const insuranceUf = des + inc;
  const bal = Math.max(0, input.balanceUfBefore);
  const interestUf = bal * (input.annualRate / 12);
  let principalUf = input.totalUfPaid - insuranceUf - interestUf;
  if (principalUf < -1e-4) {
    warnings.push(
      `paid UF (${input.totalUfPaid.toFixed(4)}) < interest+insurance (${(interestUf + insuranceUf).toFixed(4)}); principal clamped to 0`
    );
    principalUf = 0;
  }
  const minDiv = input.minDividendUf;
  if (minDiv != null && minDiv > 0) {
    const piPaid = input.totalUfPaid - insuranceUf;
    if (piPaid + 1e-4 < minDiv) {
      warnings.push(`P+I paid UF ${piPaid.toFixed(4)} below min dividend UF ${minDiv} this month`);
    }
  }
  const balanceUfAfter = input.balanceUfBefore - principalUf;
  return {
    interestUf,
    desgravamenUf: des,
    incendioUf: inc,
    insuranceUf,
    principalUf,
    balanceUfAfter,
    warnings,
  };
}

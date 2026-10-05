/**
 * Charges the bank itself takes from a checking account — the plan's monthly maintenance fee, the
 * línea de crédito's interest and the overdraft tax. They are the account's cost, not money the
 * user moved, so the checking importers store them as `cash_fee`: the deposit-event loaders skip
 * that kind (accountDeposits.ts), which makes the charge a loss in the account's P/L instead of a
 * withdrawal. The balance walk debits a `cash_fee` row like any other (brokerageFlowMovement.ts),
 * and the Gastos view reads checking debits whatever their kind, so the fee still counts there.
 *
 * Decided at import from the bank's own description — never from the stored note at runtime.
 */

/** Bank descriptions (normalized: upper case, no accents, single spaces). */
const CHECKING_BANK_CHARGE_DESCRIPTIONS: ReadonlySet<string> = new Set([
  "COM.MANTENCION PLAN",
  "INTERESES LINEA DE CREDITO",
  "IMPUESTO SOBREGIRO",
  "IMPUESTO SOBREGIRO / USO LCA",
]);

function normalizeBankDescription(raw: string): string {
  return raw
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toUpperCase()
    .replace(/\s+/g, " ")
    .trim();
}

export function isCheckingBankChargeDescription(description: string): boolean {
  return CHECKING_BANK_CHARGE_DESCRIPTIONS.has(normalizeBankDescription(description));
}

/**
 * `cash_fee` for a bank charge, else null. A charge description on a credit is not a pattern the
 * bank has printed (a reversal carries its own wording), so it throws instead of guessing a sign.
 */
export function checkingMovementFlowKind(description: string, amountClp: number): "cash_fee" | null {
  if (!isCheckingBankChargeDescription(description)) return null;
  if (!(amountClp < 0)) {
    throw new Error(
      `checking bank charge «${description}» with a non-negative amount (${amountClp}): unknown pattern`
    );
  }
  return "cash_fee";
}

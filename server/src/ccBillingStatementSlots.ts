import { ccIssuerSlugForMasterAccount } from "./ccIssuerForAccount.js";
import { ccIssuerBySlug } from "./ccIssuers.js";
import { isStatementSourceKind } from "./ccStatementSourceKind.js";
import { listCcStatementsForAccount, type CcStatementRow } from "./ccStatementsDb.js";

/** A billing month's statements, by lowercase currency code. */
export type CcStatementSlotByCurrency = Map<string, CcStatementRow>;

function assignStatementToSlot(slot: CcStatementSlotByCurrency, st: CcStatementRow, currency: string): void {
  const current = slot.get(currency);
  if (!current) {
    slot.set(currency, st);
    return;
  }
  const curPdf = isStatementSourceKind(current.source_kind);
  const nextPdf = isStatementSourceKind(st.source_kind);
  if (curPdf && !nextPdf) return;
  slot.set(currency, st);
}

/**
 * The statement a facturación row is dated and keyed by: the issuer's primary currency's, else
 * whichever other statement the slot holds (a month only a secondary currency's statement closed).
 */
export function primaryStatementOfSlot(accountId: number, slot: CcStatementSlotByCurrency): CcStatementRow | null {
  const primary = ccIssuerBySlug(ccIssuerSlugForMasterAccount(accountId))!.statement_currencies.primary;
  return slot.get(primary) ?? slot.values().next().value ?? null;
}

/**
 * True when every required currency (`requiredStatementCurrenciesForAccount`) has an imported
 * statement (not web-paste) in this billing month's slot. What a statement import may settle in
 * the open buckets: each currency's statement settles its own, all together settle everything.
 * Not the close rule — a month whose secondary statement is not coming also closes
 * (`pdfClosedBillingMonthsForAccount`), but its lines in that currency still wait for a statement.
 */
export function hasEveryStatementTwinForBillingMonth(
  slot: CcStatementSlotByCurrency | undefined,
  requiredCurrencies: ReadonlySet<string>
): boolean {
  if (!slot) return false;
  for (const currency of requiredCurrencies) {
    const st = slot.get(currency);
    if (!st || !isStatementSourceKind(st.source_kind)) return false;
  }
  return requiredCurrencies.size > 0;
}

export function statementSlotsByBillingMonth(accountId: number): Map<string, CcStatementSlotByCurrency> {
  const byMonth = new Map<string, CcStatementSlotByCurrency>();
  for (const st of listCcStatementsForAccount(accountId)) {
    const bm = st.billing_month;
    if (!bm) continue;
    let slot = byMonth.get(bm);
    if (!slot) {
      slot = new Map();
      byMonth.set(bm, slot);
    }
    assignStatementToSlot(slot, st, st.currency);
  }
  return byMonth;
}

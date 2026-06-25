import { isPdfStatementSource } from "./ccManualBillingMonth.js";
import { listCcStatementsForAccount, type CcStatementRow } from "./ccStatementsDb.js";

export type CcStatementSlotByCurrency = {
  clp: CcStatementRow | null;
  usd: CcStatementRow | null;
};

function assignStatementToSlot(
  slot: CcStatementSlotByCurrency,
  st: CcStatementRow,
  currency: "clp" | "usd"
): void {
  const current = currency === "usd" ? slot.usd : slot.clp;
  if (!current) {
    if (currency === "usd") slot.usd = st;
    else slot.clp = st;
    return;
  }
  const curPdf = isPdfStatementSource(current.source_pdf);
  const nextPdf = isPdfStatementSource(st.source_pdf);
  if (!curPdf && nextPdf) {
    if (currency === "usd") slot.usd = st;
    else slot.clp = st;
  } else if (curPdf && !nextPdf) {
    return;
  } else {
    if (currency === "usd") slot.usd = st;
    else slot.clp = st;
  }
}

export function statementSlotsByBillingMonth(accountId: number): Map<string, CcStatementSlotByCurrency> {
  const byMonth = new Map<string, CcStatementSlotByCurrency>();
  for (const st of listCcStatementsForAccount(accountId)) {
    const bm = st.billing_month;
    if (!bm) continue;
    let slot = byMonth.get(bm);
    if (!slot) {
      slot = { clp: null, usd: null };
      byMonth.set(bm, slot);
    }
    assignStatementToSlot(slot, st, st.currency === "usd" ? "usd" : "clp");
  }
  return byMonth;
}

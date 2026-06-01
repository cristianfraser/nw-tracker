import type { ImportSyncDocumentAccount } from "../../types";

export type AvailableDocumentsSingleColumn = {
  type: "single";
  accountIndex: number;
  account: ImportSyncDocumentAccount;
};

export type AvailableDocumentsSplitColumn = {
  type: "cc_split";
  accountId: number;
  label: string;
  usdIndex: number;
  clpIndex: number;
};

export type AvailableDocumentsColumn =
  | AvailableDocumentsSingleColumn
  | AvailableDocumentsSplitColumn;

/** One table column, or one card column with USD + CLP sub-columns. */
export function buildAvailableDocumentsColumns(
  accounts: ImportSyncDocumentAccount[]
): AvailableDocumentsColumn[] {
  const cols: AvailableDocumentsColumn[] = [];
  let i = 0;
  while (i < accounts.length) {
    const acc = accounts[i]!;
    const next = accounts[i + 1];
    if (
      acc.cc_statement_currency === "clp" &&
      next?.account_id === acc.account_id &&
      next.cc_statement_currency === "usd"
    ) {
      cols.push({
        type: "cc_split",
        accountId: acc.account_id,
        label: acc.label,
        clpIndex: i,
        usdIndex: i + 1,
      });
      i += 2;
      continue;
    }
    cols.push({ type: "single", accountIndex: i, account: acc });
    i += 1;
  }
  return cols;
}

export function availableDocumentsColumnsHaveSplit(
  columns: AvailableDocumentsColumn[]
): boolean {
  return columns.some((c) => c.type === "cc_split");
}

import { resolveMasterAccountIdForImportCardLast4 } from "./ccConsolidatedCards.js";
import { listCreditCardGroupMasterAccountIds } from "./creditCardTree.js";

/** Last4 from CSV `card_last4` or `source_pdf` filename (e.g. `… tarjeta <last4>.pdf`). */
export function cardLast4FromParsedRow(row: Record<string, string>): string {
  const l4 = String(row.card_last4 ?? "").trim();
  if (l4) return l4;
  const pdf = String(row.source_pdf ?? "");
  const m = /(\d{4})\.pdf/i.exec(pdf);
  return m?.[1] ?? "";
}

export type DiscoverImportAccountsResult = {
  accountIds: number[];
  /** last4 values present in CSV but with no master account in DB */
  unknownLast4: string[];
  /** rows with no last4 and no parseable PDF name */
  rowsWithoutCard: number;
};

/**
 * Map parsed statement CSV rows to master account ids (one per physical card).
 * Applies consolidation redirects (predecessor → successor master, from cc-cards.json).
 */
export function discoverMasterAccountIdsFromParsedRows(
  records: Record<string, string>[]
): DiscoverImportAccountsResult {
  const byLast4 = new Map<string, number>();
  const unknownLast4 = new Set<string>();
  let rowsWithoutCard = 0;

  for (const row of records) {
    const l4 = cardLast4FromParsedRow(row);
    if (!l4) {
      rowsWithoutCard += 1;
      continue;
    }
    const accId = resolveMasterAccountIdForImportCardLast4(l4);
    if (accId == null) {
      unknownLast4.add(l4);
      continue;
    }
    byLast4.set(l4, accId);
  }

  const accountIds = [...new Set(byLast4.values())].sort((a, b) => a - b);
  return {
    accountIds,
    unknownLast4: [...unknownLast4].sort(),
    rowsWithoutCard,
  };
}

export type ResolveImportAccountIdsOpts = {
  records: Record<string, string>[];
  /** Restrict to one master account (still requires matching card rows in CSV). */
  accountId?: number;
  /** Restrict discovered ids to masters under this credit_card_group slug. */
  groupSlug?: string;
};

/**
 * Default: every card last4 in the CSV. Optional filters: `--account-id`, `--santander` (group slug).
 */
export function resolveImportAccountIds(
  opts: ResolveImportAccountIdsOpts
): { accountIds: number[]; discovery: DiscoverImportAccountsResult } {
  const discovery = discoverMasterAccountIdsFromParsedRows(opts.records);
  let accountIds = discovery.accountIds;

  if (opts.groupSlug) {
    const allowed = new Set(listCreditCardGroupMasterAccountIds(opts.groupSlug));
    accountIds = accountIds.filter((id) => allowed.has(id));
  }

  if (opts.accountId != null && Number.isFinite(opts.accountId) && opts.accountId > 0) {
    accountIds = accountIds.filter((id) => id === opts.accountId);
    if (accountIds.length === 0) {
      accountIds = [opts.accountId];
    }
  }

  return { accountIds, discovery };
}

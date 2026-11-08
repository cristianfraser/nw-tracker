/**
 * The one resolver for card documents (docs/untangle-plan.md F13): which card master a document
 * belongs to. A document names its card one of two ways —
 *
 * - by the issuer's account number (`{ issuer, number }`: the feed listing, the statement JSON,
 *   the issuer's balances), mapped through gitignored `cfraser/organize-identifiers.json`
 *   (`santander_80_account_to_card_last4`, the same identity table the inbox organizer files the
 *   statement PDFs by) to the card's last4;
 * - by the plastic's last4 (a parsed statement's `card_last4`, else the last4 in its file name).
 *
 * Either way the last4 goes through the card registry's consolidation redirects
 * (`cfraser/cc-cards.json`) to the master whose `credit_card_account_config.card_last4` it is.
 * Import-time only — never a request path. An unmapped number or a last4 no master carries is a
 * data problem to fix, never a card to skip.
 */
import fs from "node:fs";
import path from "node:path";
import type { CardCanonicalStatement } from "nw-tracker-contracts";
import { resolveCfraserCsvDir } from "../cfraserPaths.js";
import { resolveMasterAccountIdForImportCardLast4 } from "../ccConsolidatedCards.js";
import type { CcIssuerSlug } from "../ccIssuers.js";
import { listCreditCardMasterAccountIdsForIssuer } from "../creditCardTree.js";

type OrganizeIdentifiers = {
  santander_80_account_to_card_last4?: Record<string, string>;
};

export function resolveOrganizeIdentifiersPath(): string {
  const override = process.env.NW_TRACKER_ORGANIZE_IDENTIFIERS?.trim();
  if (override) return path.resolve(override);
  return path.join(resolveCfraserCsvDir(), "organize-identifiers.json");
}

function loadIdentifiers(): OrganizeIdentifiers {
  const file = resolveOrganizeIdentifiersPath();
  if (!fs.existsSync(file)) {
    throw new Error(
      `Missing ${file} — it maps Santander account numbers to card last4. ` +
        `Restore it from the backups directory.`
    );
  }
  return JSON.parse(fs.readFileSync(file, "utf8")) as OrganizeIdentifiers;
}

/** Card last4 for a Santander account number, or null when the mapping has no entry. */
export function cardLast4ForSantanderAccount(account: string): string | null {
  const key = String(account ?? "").trim();
  if (!key) return null;
  const map = loadIdentifiers().santander_80_account_to_card_last4 ?? {};
  return map[key] ?? null;
}

/** The card master a document naming the issuer's account number belongs to. */
export function cardAccountForIssuerNumber(account: { issuer: string; number: string }): number {
  if (account.issuer !== "santander") {
    throw new Error(`No card-account mapping for issuer "${account.issuer}" (account ${account.number})`);
  }
  const last4 = cardLast4ForSantanderAccount(account.number);
  if (!last4) {
    throw new Error(
      `Santander account ${account.number} is not in santander_80_account_to_card_last4 ` +
        `(cfraser/organize-identifiers.json) — add its card last4.`
    );
  }
  const accountId = resolveMasterAccountIdForImportCardLast4(last4);
  if (!accountId) {
    throw new Error(`No credit-card master account has card_last4 ${last4} (Santander account ${account.number}).`);
  }
  return accountId;
}

/** The plastic a statement names: its `card_last4`, else the last4 in its file name (`… tarjeta <last4>.pdf`). */
export function cardLast4OfStatement(statement: Pick<CardCanonicalStatement, "card_last4" | "document">): string {
  const l4 = String(statement.card_last4 ?? "").trim();
  if (l4) return l4;
  return /(\d{4})\.pdf/i.exec(statement.document)?.[1] ?? "";
}

/** The card master a statement belongs to (null: no master carries its plastic). */
export function cardAccountForStatement(statement: Pick<CardCanonicalStatement, "card_last4" | "document">): number | null {
  return resolveMasterAccountIdForImportCardLast4(cardLast4OfStatement(statement));
}

export type CardStatementAccounts = {
  /** Masters that take at least one statement, ascending. */
  accountIds: number[];
  /** Statements per master. */
  byAccount: Map<number, CardCanonicalStatement[]>;
  /** Plastics no master carries. */
  unknownLast4: string[];
  /** Lines on statements that name no plastic at all. */
  linesWithoutCard: number;
  /** Lines on statements whose plastic no master carries. */
  linesUnknownCard: number;
};

/**
 * Statements routed to their masters. `accountId` restricts to one master (and names it even when
 * none of the statements is its), `issuer` to the masters of one issuer (maintenance runs).
 */
export function cardAccountsForStatements(
  statements: readonly CardCanonicalStatement[],
  opts?: { accountId?: number; issuer?: CcIssuerSlug }
): CardStatementAccounts {
  const byAccount = new Map<number, CardCanonicalStatement[]>();
  const unknown = new Set<string>();
  let linesWithoutCard = 0;
  let linesUnknownCard = 0;
  for (const st of statements) {
    const l4 = cardLast4OfStatement(st);
    if (!l4) {
      linesWithoutCard += st.lines.length;
      continue;
    }
    const accountId = resolveMasterAccountIdForImportCardLast4(l4);
    if (accountId == null) {
      unknown.add(l4);
      linesUnknownCard += st.lines.length;
      continue;
    }
    const list = byAccount.get(accountId) ?? [];
    list.push(st);
    byAccount.set(accountId, list);
  }
  let accountIds = [...byAccount.keys()].sort((a, b) => a - b);
  if (opts?.issuer) {
    const allowed = new Set(listCreditCardMasterAccountIdsForIssuer(opts.issuer));
    accountIds = accountIds.filter((id) => allowed.has(id));
  }
  if (opts?.accountId != null && Number.isFinite(opts.accountId) && opts.accountId > 0) {
    accountIds = accountIds.filter((id) => id === opts.accountId);
    if (accountIds.length === 0) accountIds = [opts.accountId];
  }
  return { accountIds, byAccount, unknownLast4: [...unknown].sort(), linesWithoutCard, linesUnknownCard };
}

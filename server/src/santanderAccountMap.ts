import fs from "node:fs";
import path from "node:path";
import { resolveCfraserCsvDir } from "./cfraserPaths.js";
import { resolveMasterAccountIdForCardLast4 } from "./creditCardTree.js";

/**
 * Santander account number → card last4, from gitignored `cfraser/organize-identifiers.json`.
 *
 * The same file already maps these for the inbox organizer (statement PDFs are named
 * `80_<seq>_<account>_<date>.pdf`), so the fetched movement feed resolves through exactly the same
 * identity table rather than a second, drifting copy. Import-time only — never a request path.
 */
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

/**
 * Resolve a fetched movement slide's account number to its nw-tracker master account.
 *
 * Fails loudly on either half of the lookup: an unmapped account number or a last4 with no
 * `credit_card_account_config` row is a data problem to fix, not a card to silently skip.
 */
export function masterAccountIdForSantanderAccount(account: string): number {
  const last4 = cardLast4ForSantanderAccount(account);
  if (!last4) {
    throw new Error(
      `Santander account ${account} is not in santander_80_account_to_card_last4 ` +
        `(cfraser/organize-identifiers.json) — add its card last4.`
    );
  }
  const accountId = resolveMasterAccountIdForCardLast4(last4);
  if (!accountId) {
    throw new Error(`No credit-card master account has card_last4 ${last4} (Santander account ${account}).`);
  }
  return accountId;
}

/**
 * The card master an ingested listing names (`{ issuer, number }` in `card.unbilled_movements`).
 * Only Santander account numbers are mapped today; any other issuer is a data problem to fix,
 * never a card to skip.
 */
export function masterAccountIdForIssuerCardAccount(account: { issuer: string; number: string }): number {
  if (account.issuer === "santander") return masterAccountIdForSantanderAccount(account.number);
  throw new Error(`No card-account mapping for issuer "${account.issuer}" (account ${account.number})`);
}

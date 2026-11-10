/**
 * The US retirement accounts by kind (a 401(k), an HSA, a Roth IRA), read from their identity
 * (`usRetirementAccountImportKey`): the one place a tax reader asks whether an account is a Roth —
 * whose growth is income to neither return — so no reader matches on a name.
 *
 * A leaf of the valuation core, like `accountRoles.ts`: database reads only.
 */
import { db } from "./db.js";
import { dbStateMemo } from "./dbStateMemo.js";
import { usRetirementAccountImportKeyPrefix, type UsRetirementAccountKind } from "./accountIdentityKeys.js";

const stmt = db.prepare(`SELECT id FROM accounts WHERE import_key LIKE ? ESCAPE '\\' ORDER BY id`);

/** Every account whose import key says it is a US retirement account of `kind`, ascending by id. */
export function usRetirementAccountIds(kind: UsRetirementAccountKind): number[] {
  return dbStateMemo("us_retirement_account_ids", kind, () => {
    const prefix = usRetirementAccountImportKeyPrefix(kind).replace(/[\\%_]/g, (c) => `\\${c}`);
    return (stmt.all(`${prefix}%`) as { id: number }[]).map((r) => r.id);
  });
}

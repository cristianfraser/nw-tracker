import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db } from "./db.js";
import { usRetirementAccountImportKey } from "./accountIdentityKeys.js";
import { usRetirementAccountIds } from "./usRetirementAccounts.js";
import { loadF22Dividends } from "./f22Draft.js";

const PREFIX = "vitest-roth-dividends";
/** A year no fixture person has dividends in. */
const YEAR = 2009;
const created: number[] = [];

function account(leafSlug: string, importKey: string, ticker: string | null): number {
  const leaf = db.prepare(`SELECT id FROM asset_groups WHERE slug = ?`).get(leafSlug) as { id: number } | undefined;
  if (!leaf) throw new Error(`asset group ${leafSlug} missing`);
  const id = Number(
    db
      .prepare(`INSERT INTO accounts (asset_group_id, name, import_key, equity_ticker) VALUES (?, ?, ?, ?)`)
      .run(leaf.id, `${PREFIX} ${importKey}`, importKey, ticker).lastInsertRowid
  );
  created.push(id);
  return id;
}

function dividend(from: number, to: number, day: string, usd: number): number {
  return Number(
    db
      .prepare(
        `INSERT INTO movements (account_id, from_account_id, to_account_id, amount, currency, occurred_on, note, flow_kind)
         VALUES (NULL, ?, ?, ?, 'usd', ?, ?, 'dividend_payout')`
      )
      .run(from, to, usd, day, `${PREFIX} dividend`).lastInsertRowid
  );
}

describe("a Roth IRA's dividends and the F22", () => {
  let roth = 0;
  let brokerage = 0;
  let rothDividend = 0;
  let brokerageDividend = 0;

  beforeAll(() => {
    roth = account("retirement_us_roth_ira__roth_ira", usRetirementAccountImportKey("roth_ira", "vitest_roth"), "SPY");
    const sweep = account("cash_eqs__cash_savings", `import:panel|kind=usd|key=${PREFIX}_sweep`, null);
    brokerage = account("brokerage_acciones", `import:panel|ticker=SPY|key=${PREFIX}_spy`, "SPY");
    const cash = account("cash_eqs__cash_savings", `import:panel|kind=usd|key=${PREFIX}_cash`, null);
    rothDividend = dividend(roth, sweep, `${YEAR}-03-09`, 12.5);
    brokerageDividend = dividend(brokerage, cash, `${YEAR}-03-09`, 8.25);
  });

  afterAll(() => {
    db.prepare(`DELETE FROM movements WHERE note = ?`).run(`${PREFIX} dividend`);
    for (const id of created) db.prepare(`DELETE FROM accounts WHERE id = ?`).run(id);
  });

  it("finds the Roth by its identity, never its name", () => {
    expect(usRetirementAccountIds("roth_ira")).toContain(roth);
    expect(usRetirementAccountIds("roth_ira")).not.toContain(brokerage);
    expect(usRetirementAccountIds("us_401k")).not.toContain(roth);
  });

  it("leaves the Roth's dividend out of the year's foreign dividends", () => {
    const ids = loadF22Dividends(YEAR).map((d) => d.movementId);
    expect(ids).toContain(brokerageDividend);
    expect(ids).not.toContain(rothDividend);
  });
});

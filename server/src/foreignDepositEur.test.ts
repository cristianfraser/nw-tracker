/**
 * A deposit made in euros (untangle wave 9, the deposits reconciliation per currency): a single-leg
 * euro row buying units of a non-cash account is a deposit event carrying its euros, and the
 * deposits reconciliation prices it at those euros (never 0 pesos), reads them as they are in the
 * euro unit, and takes its "checking present" from the months a EURO checking account lists.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { addDaysIso } from "nw-tracker-contracts";
import { loadMergedDepositInflowEvents } from "./accountDeposits.js";
import { chileCalendarTodayYmd } from "./chileDate.js";
import { createPanelAccount } from "./createPanelAccount.js";
import { db } from "./db.js";
import { buildDepositsReconciliationPayload, classifyDepositsReconciliation } from "./flowsDepositsReconciliation.js";
import { foreignCashToClpAt } from "./foreignCashAccounts.js";
import { convertCurrency, flowEventInUnit } from "./rates.js";

const PREFIX = "Vitest · euro deposit";

describe("a deposit made in euros", () => {
  const today = chileCalendarTodayYmd();
  // Two days in different months: the euro checking lists a row in the first one only.
  const listedDay = addDaysIso(today, -40);
  const unlistedDay = addDaysIso(today, -75);
  const created: { account_id: number; asset_group_id: number; created_leaf_bucket: boolean }[] = [];
  const accounts: number[] = [];
  let checkingEur = 0;
  let stock = 0;
  let fund = 0;

  const insert = (sql: string, ...args: unknown[]): number => Number(db.prepare(sql).run(...args).lastInsertRowid);

  beforeAll(() => {
    const checking = createPanelAccount({
      account: {
        account_type: "foreign_cash",
        currency: "eur",
        name: `${PREFIX} checking`,
        bucket_slug: "checking_accounts",
        category_slug: "vitest_eur_deposit_checking",
        exclude_from_group_totals: true,
      },
    });
    created.push(checking);
    checkingEur = checking.account_id;
    const stockLeaf = db.prepare(`SELECT id FROM asset_groups WHERE slug LIKE 'brokerage_acciones__%' LIMIT 1`).get() as { id: number };
    stock = insert(`INSERT INTO accounts (asset_group_id, name, equity_ticker) VALUES (?, ?, 'VDRC')`, stockLeaf.id, `${PREFIX} stock`);
    const fundLeaf = db.prepare(`SELECT id FROM asset_groups WHERE slug = 'retirement_us_401k__us_401k'`).get() as { id: number };
    fund = insert(
      `INSERT INTO accounts (asset_group_id, name, notes, fund_series_key) VALUES (?, ?, 'vitest', 'vitest_eur_fund')`,
      fundLeaf.id,
      `${PREFIX} fund`
    );
    accounts.push(stock, fund);
    // The euro checking account lists one debit in the first month.
    insert(
      `INSERT INTO movements (account_id, amount, currency, occurred_on, note, flow_kind) VALUES (?, 300.4, 'eur', ?, ?, 'withdrawal')`,
      checkingEur,
      listedDay,
      `import:cartola|${listedDay.slice(0, 7)}|Madrid|VITEST BROKER|doc:vitest-eurdep|on:${listedDay}|amt:-30040|idx:990`
    );
  });

  afterAll(() => {
    const ids = [checkingEur, ...accounts];
    const ph = ids.map(() => "?").join(",");
    db.prepare(`DELETE FROM movements WHERE account_id IN (${ph})`).run(...ids);
    for (const id of accounts) db.prepare(`DELETE FROM accounts WHERE id = ?`).run(id);
    for (const c of created) {
      db.prepare(`DELETE FROM accounts WHERE id = ?`).run(c.account_id);
      if (c.created_leaf_bucket) db.prepare(`DELETE FROM asset_groups WHERE id = ?`).run(c.asset_group_id);
    }
  });

  it("reconciles at its euros, its coverage read from the euro checking's months", () => {
    const present = insert(
      `INSERT INTO movements (account_id, amount, currency, occurred_on, note, units_delta) VALUES (?, 300.4, 'eur', ?, 'vitest shares in', 2)`,
      stock,
      listedDay
    );
    const noSource = insert(
      `INSERT INTO movements (account_id, amount, currency, occurred_on, note, units_delta) VALUES (?, 120.25, 'eur', ?, 'vitest shares in', 1)`,
      stock,
      unlistedDay
    );
    // A euro row moving no units is not a deposit (as the deposit events read it).
    const noUnits = insert(`INSERT INTO movements (account_id, amount, currency, occurred_on, note) VALUES (?, 70, 'eur', ?, 'vitest no units')`, stock, listedDay);

    const rows = classifyDepositsReconciliation().rows;
    const presentClp = foreignCashToClpAt(300.4, "eur", listedDay, "vitest");
    expect(presentClp).toBeGreaterThan(0);
    expect(rows.find((r) => r.movement_id === present)).toMatchObject({
      account_id: stock,
      category: "brokerage",
      amount_clp: presentClp,
      native: { currency: "eur", amount: 300.4 },
      status: "unlinked_checking_present",
    });
    // No euro checking account lists that month, whatever the peso and dollar accounts list.
    expect(rows.find((r) => r.movement_id === noSource)).toMatchObject({
      amount_clp: foreignCashToClpAt(120.25, "eur", unlistedDay, "vitest"),
      native: { currency: "eur", amount: 120.25 },
      status: "unlinked_no_checking_source",
    });
    expect(rows.find((r) => r.movement_id === noUnits)).toBeUndefined();

    // The euro unit reads the euros as they are; pesos the priced pesos; dollars the euros at the day's rate.
    const inUnit = (unit: string) => buildDepositsReconciliationPayload(unit).rows.find((r) => r.movement_id === present)!;
    expect(inUnit("eur").amount).toBe(300.4);
    expect(inUnit("eur")).not.toHaveProperty("native");
    expect(inUnit("clp").amount).toBe(presentClp);
    expect(inUnit("usd").amount).toBeCloseTo(convertCurrency(300.4, "eur", "usd", listedDay, { side: "mid", storedOnly: true })!, 6);
    // The euro checking's own debit is the funding source, never a redemption to reconcile.
    expect(buildDepositsReconciliationPayload("eur").redemptions.some((r) => r.account_id === checkingEur)).toBe(false);
  });

  it("is a deposit event carrying its euros, in pesos at the day's rate", () => {
    db.prepare(`INSERT INTO movements (account_id, amount, currency, occurred_on, note, units_delta) VALUES (?, 624, 'eur', ?, 'vitest fund units', 24.5)`).run(fund, listedDay);
    db.prepare(`INSERT INTO movements (account_id, amount, currency, occurred_on, note) VALUES (?, 50, 'eur', ?, 'no units')`).run(fund, listedDay);
    const events = loadMergedDepositInflowEvents([fund]).get(fund) ?? [];
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      occurred_on: listedDay,
      amt: foreignCashToClpAt(624, "eur", listedDay, "vitest"),
      amt_native: 624,
      native_currency: "eur",
    });
    expect(events[0]).not.toHaveProperty("amt_usd");
    expect(flowEventInUnit(events[0]!, "eur")).toBe(624);
    expect(flowEventInUnit(events[0]!, "clp")).toBe(events[0]!.amt);
  });
});

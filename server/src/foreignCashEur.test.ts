import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db } from "./db.js";
import { createPanelAccount } from "./createPanelAccount.js";
import { accountValueAt } from "./accountValue.js";
import { foreignCashBalanceAt, foreignCashCurrencyOf } from "./foreignCashAccounts.js";
import { loadMergedDepositInflowEvents } from "./accountDeposits.js";
import { validateMovementCreate } from "./movementUnitsPolicy.js";
import { accountRowForId } from "./accountRowForMovement.js";
import { accountProfile } from "./accountProfile.js";
import { flowEventInUnit } from "./rates.js";
import { convertValue } from "./valueConvert.js";
import { chileCalendarTodayYmd } from "./chileDate.js";
import { addDaysIso } from "nw-tracker-contracts";

/**
 * A euro cash account end to end (docs/any-currency-plan.md Phase C1): declared currency, a
 * single-leg euro deposit, an exchange from pesos, its balance, its value in pesos / dollars /
 * euros through the rates, and its deposit events in its own currency.
 */
describe("a euro cash account", () => {
  const created: { account_id: number; asset_group_id: number; created_leaf_bucket: boolean }[] = [];
  let eurId = 0;
  let clpId = 0;
  const today = chileCalendarTodayYmd();
  const depositDay = addDaysIso(today, -60);
  const exchangeDay = addDaysIso(today, -30);
  const asOf = addDaysIso(today, -10);

  beforeAll(() => {
    const eur = createPanelAccount({
      account: {
        account_type: "foreign_cash",
        currency: "eur",
        name: "Vitest EUR cash",
        bucket_slug: "cash_savings",
        category_slug: "vitest_eur_cash",
        exclude_from_group_totals: true,
      },
    });
    const clp = createPanelAccount({
      account: {
        account_type: "clp_cash",
        name: "Vitest CLP source",
        bucket_slug: "cash_savings",
        category_slug: "vitest_eur_cash_source",
        exclude_from_group_totals: true,
      },
    });
    created.push(eur, clp);
    eurId = eur.account_id;
    clpId = clp.account_id;

    const deposit = validateMovementCreate(accountRowForId(eurId)!, {
      occurred_on: depositDay,
      flow_kind: "deposit",
      amount: 1000,
      currency: "eur",
    });
    if (!deposit.ok || deposit.mode !== "brokerage") throw new Error(`deposit refused: ${JSON.stringify(deposit)}`);
    db.prepare(
      `INSERT INTO movements (account_id, amount, currency, occurred_on, note, flow_kind) VALUES (?, ?, ?, ?, 'vitest-eur', ?)`
    ).run(eurId, deposit.amount, deposit.currency, deposit.occurred_on, deposit.flow_kind);

    const exchange = validateMovementCreate(
      accountRowForId(eurId)!,
      {
        occurred_on: exchangeDay,
        flow_kind: "fx_exchange",
        amount: 500_000,
        currency: "clp",
        counter_amount: 480.5,
        counter_currency: "eur",
        counterpart_account_id: clpId,
        counterpart_role: "from",
      },
      eurId
    );
    if (!exchange.ok || exchange.mode !== "transfer") throw new Error(`exchange refused: ${JSON.stringify(exchange)}`);
    db.prepare(
      `INSERT INTO movements (from_account_id, to_account_id, amount, currency, counter_amount, counter_currency, occurred_on, note, flow_kind)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'vitest-eur', ?)`
    ).run(
      exchange.from_account_id,
      exchange.to_account_id,
      exchange.amount,
      exchange.currency,
      exchange.counter_amount,
      exchange.counter_currency,
      exchange.occurred_on,
      exchange.flow_kind
    );
  });

  afterAll(() => {
    db.prepare(`DELETE FROM movements WHERE note = 'vitest-eur'`).run();
    for (const c of created) {
      db.prepare(`DELETE FROM accounts WHERE id = ?`).run(c.account_id);
      if (c.created_leaf_bucket) db.prepare(`DELETE FROM asset_groups WHERE id = ?`).run(c.asset_group_id);
    }
  });

  it("declares its currency and holds it", () => {
    expect(foreignCashCurrencyOf(eurId)).toBe("eur");
    expect(accountProfile(eurId).quantity).toEqual({ kind: "foreign_ledger", currency: "eur" });
    expect(accountProfile(eurId).holding).toEqual({ kind: "currency", code: "eur" });
  });

  it("refuses an amount in another currency", () => {
    const wrong = validateMovementCreate(accountRowForId(eurId)!, {
      occurred_on: depositDay,
      flow_kind: "deposit",
      amount: 1000,
      currency: "usd",
    });
    expect(wrong.ok).toBe(false);
  });

  it("sums its euro legs into its balance", () => {
    expect(foreignCashBalanceAt(eurId, addDaysIso(depositDay, -1))).toBe(0);
    expect(foreignCashBalanceAt(eurId, depositDay)).toBe(1000);
    expect(foreignCashBalanceAt(eurId, asOf)).toBe(1480.5);
  });

  it("is valued in any display unit through the rates", () => {
    expect(accountValueAt(eurId, asOf, "eur")?.value).toBeCloseTo(1480.5, 6);
    const clp = convertValue(1480.5, "eur", "clp", asOf, "asset");
    const usd = convertValue(1480.5, "eur", "usd", asOf, "asset");
    expect(clp).not.toBeNull();
    expect(usd).not.toBeNull();
    expect(accountValueAt(eurId, asOf, "clp")?.value).toBeCloseTo(clp!, 6);
    expect(accountValueAt(eurId, asOf, "usd")?.value).toBeCloseTo(usd!, 6);
  });

  it("carries its deposit events in euros, the exchange at the pesos spent", () => {
    const events = loadMergedDepositInflowEvents([eurId]).get(eurId) ?? [];
    expect(events.map((e) => e.occurred_on)).toEqual([depositDay, exchangeDay]);
    expect(events.map((e) => flowEventInUnit(e, "eur"))).toEqual([1000, 480.5]);
    // The exchange's pesos are what left the peso account; the deposit is its euros at the day's sell side.
    expect(events[1]!.amt).toBe(500_000);
    expect(events[0]!.amt).toBeGreaterThan(0);
    expect(events.every((e) => e.amt_usd == null)).toBe(true);
    // The peso side of the exchange leaves the peso account's capital.
    const clpEvents = loadMergedDepositInflowEvents([clpId]).get(clpId) ?? [];
    expect(clpEvents.map((e) => e.amt)).toEqual([-500_000]);
  });
});

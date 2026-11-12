import { foreignCashToClpAt } from "./foreignCashAccounts.js";
/**
 * The dollar checking account in the deposits reconciliation and the mirror pairs: a dollar
 * deposit (a single-leg dollar row buying units) reconciles at its dollars priced at the day's rate,
 * its "checking present" read from the dollar checking accounts' listed months; and the mirror
 * pairs stay peso-only — a dollar debit and a same-dollar credit are never offered as a pair.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { listDollarCheckingAccountIds } from "./checkingCartolaLoaders.js";
import { chileCalendarTodayYmd } from "./chileDate.js";
import { db } from "./db.js";
import { buildDepositsReconciliationPayload, classifyDepositsReconciliation } from "./flowsDepositsReconciliation.js";
import { listMirrorPairCandidates } from "./movementMirrorPairs.js";
import { overrideFxDaily } from "./test/fxDailyFixture.js";

const RATE = 950;
const PREFIX = "Vitest · dollar reconciliation";

function addDays(day: string, n: number): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
}

describe("a dollar checking account in the deposits reconciliation and the mirror pairs", () => {
  const recent = addDays(chileCalendarTodayYmd(), -40);
  // Before the Vitest person's history: no dollar checking listing in that month.
  const ancient = addDays(chileCalendarTodayYmd(), -1500);
  const created: { accounts: number[]; movements: number[] } = { accounts: [], movements: [] };
  let checkingUsd = 0;
  let restoreFx: () => void = () => {};

  const stockAccount = (): number => {
    const leaf = db.prepare(`SELECT id FROM asset_groups WHERE slug LIKE 'brokerage_acciones__%' LIMIT 1`).get() as { id: number };
    const id = Number(
      db.prepare(`INSERT INTO accounts (asset_group_id, name, equity_ticker) VALUES (?, ?, 'VDRC')`).run(leaf.id, `${PREFIX} stock`).lastInsertRowid
    );
    created.accounts.push(id);
    return id;
  };
  const movement = (sql: string, ...args: unknown[]): number => {
    const id = Number(db.prepare(sql).run(...args).lastInsertRowid);
    created.movements.push(id);
    return id;
  };
  const listedUsd = (accountId: number, description: string, usd: number, day: string, idx: number): number =>
    movement(
      `INSERT INTO movements (account_id, amount, currency, occurred_on, note, flow_kind) VALUES (?, ?, 'usd', ?, ?, ?)`,
      accountId,
      Math.abs(usd),
      day,
      `import:cartola|${day.slice(0, 7)}|Austin|${description}|doc:vitest-recon${idx}|on:${day}|amt:${Math.round(usd * 100)}|idx:${960 + idx}`,
      usd > 0 ? "fx_purchase" : "withdrawal"
    );

  beforeEach(() => {
    const dollar = listDollarCheckingAccountIds();
    expect(dollar.length).toBeGreaterThan(0);
    checkingUsd = dollar[0]!;
    restoreFx = overrideFxDaily([
      [recent, RATE],
      [ancient, RATE],
    ]);
  });
  afterEach(() => {
    for (const id of created.movements.splice(0)) db.prepare(`DELETE FROM movements WHERE id = ?`).run(id);
    for (const id of created.accounts.splice(0)) db.prepare(`DELETE FROM accounts WHERE id = ?`).run(id);
    restoreFx();
  });

  it("a dollar deposit of units reconciles at its dollars, its coverage read from the dollar checking's months", () => {
    const stock = stockAccount();
    // The dollar checking lists a movement in the recent month, none in the ancient one.
    listedUsd(checkingUsd, "VITEST BROKER TRANSFER", -1_000, recent, 0);
    const present = movement(
      `INSERT INTO movements (account_id, amount, currency, occurred_on, note, units_delta) VALUES (?, 1000, 'usd', ?, 'vitest shares in', 2)`,
      stock,
      recent
    );
    const noSource = movement(
      `INSERT INTO movements (account_id, amount, currency, occurred_on, note, units_delta) VALUES (?, 500.5, 'usd', ?, 'vitest shares in', 1)`,
      stock,
      ancient
    );
    // A dollar row moving no units is not a deposit (as the deposit events read it).
    const noUnits = movement(`INSERT INTO movements (account_id, amount, currency, occurred_on, note) VALUES (?, 70, 'usd', ?, 'vitest no units')`, stock, recent);

    const rows = classifyDepositsReconciliation().rows;
    expect(rows.find((r) => r.movement_id === present)).toMatchObject({
      account_id: stock,
      category: "brokerage",
      // Priced as the deposit event is (`accountDeposits.ts`: the dollars at the day's sell rate).
      amount_clp: foreignCashToClpAt(1000, "usd", recent, "vitest"),
      amount_usd: 1000,
      status: "unlinked_checking_present",
    });
    expect(rows.find((r) => r.movement_id === noSource)).toMatchObject({
      amount_clp: foreignCashToClpAt(500.5, "usd", ancient, "vitest"),
      amount_usd: 500.5,
      status: "unlinked_no_checking_source",
    });
    // The dollar checking's own debit is the funding source, never a redemption to reconcile.
    expect(buildDepositsReconciliationPayload("clp").redemptions.some((r) => r.account_id === checkingUsd)).toBe(false);
    expect(rows.find((r) => r.movement_id === noUnits)).toBeUndefined();
  });

  it("the mirror pairs never offer a dollar debit and a same-dollar credit", () => {
    const savings = db
      .prepare(`SELECT a.id FROM accounts a JOIN asset_groups g ON g.id = a.asset_group_id WHERE g.slug LIKE '%\\_\\_usd' ESCAPE '\\' AND a.id != ? LIMIT 1`)
      .get(checkingUsd) as { id: number } | undefined;
    expect(savings).toBeDefined();
    const out = listedUsd(checkingUsd, "VITEST TRANSFER TO SAVINGS", -2_468.13, recent, 1);
    const inn = movement(
      `INSERT INTO movements (account_id, amount, currency, occurred_on, note, flow_kind) VALUES (?, 2468.13, 'usd', ?, 'vitest savings credit', 'fx_purchase')`,
      savings!.id,
      recent
    );
    const legs = new Set([out, inn]);
    const offered = listMirrorPairCandidates().filter((c) => legs.has(c.out.movement_id) || legs.has(c.in.movement_id));
    expect(offered).toEqual([]);
  });
});

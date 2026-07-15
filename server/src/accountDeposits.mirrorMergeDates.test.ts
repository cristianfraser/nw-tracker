import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { db } from "./db.js";
import { getMergedDepositInflowEventsForAccount } from "./accountDeposits.js";
import { getAccountMonthlyPerformance } from "./accountPerformance.js";

/**
 * Mirror-converted transfers carry ONE date (the real-day checking leg for month-precision
 * pairs), but each side's valuation evidence follows its original leg. Cross-month pairs
 * (e.g. ahorro retiro dated 2021-12-31 merged with a checking deposit on 2022-01-07) must
 * bucket the aportes event by the ORIGINAL leg date per side, or the out account shows a
 * −X/+X monthly P/L couplet across the boundary.
 */

const PREFIX = "vitest-mirrormergedates";

let outAccountId = 0;
let inAccountId = 0;

function cleanup() {
  db.prepare(
    `DELETE FROM movements WHERE account_id IS NULL AND (
       from_account_id IN (SELECT id FROM accounts WHERE name LIKE '${PREFIX}-%')
       OR to_account_id IN (SELECT id FROM accounts WHERE name LIKE '${PREFIX}-%'))`
  ).run();
  db.prepare(
    `DELETE FROM valuations WHERE account_id IN (SELECT id FROM accounts WHERE name LIKE '${PREFIX}-%')`
  ).run();
  db.prepare(`DELETE FROM accounts WHERE name LIKE '${PREFIX}-%'`).run();
}

function insertTransfer(fromId: number, toId: number, amount: number, ymd: string): number {
  return Number(
    db
      .prepare(
        `INSERT INTO movements (from_account_id, to_account_id, amount_clp, occurred_on, note)
         VALUES (?,?,?,?,?)`
      )
      .run(fromId, toId, amount, ymd, `${PREFIX}|transfer`).lastInsertRowid
  );
}

beforeAll(() => {
  cleanup();
  const ahorro = db
    .prepare(
      `SELECT id FROM asset_groups WHERE slug LIKE '%\\_\\_cuenta\\_ahorro\\_vivienda' ESCAPE '\\' LIMIT 1`
    )
    .get() as { id: number } | undefined;
  if (!ahorro) throw new Error("test DB is missing the cuenta_ahorro_vivienda asset group");
  const ins = db.prepare(`INSERT INTO accounts (asset_group_id, name) VALUES (?, ?)`);
  outAccountId = Number(ins.run(ahorro.id, `${PREFIX}-out`).lastInsertRowid);
  inAccountId = Number(ins.run(ahorro.id, `${PREFIX}-in`).lastInsertRowid);
});

afterAll(cleanup);

describe("mirror-merged transfer aportes bucketing", () => {
  it("each side's deposit event uses its original leg date from movement_mirror_merges", () => {
    const transferId = insertTransfer(outAccountId, inAccountId, 800_000, "2026-01-07");
    db.prepare(
      `INSERT INTO movement_mirror_merges
         (transfer_movement_id, out_movement_id, out_occurred_on, out_amount_clp, out_note,
          in_movement_id, in_occurred_on, in_amount_clp, in_note)
       VALUES (?,?,?,?,?,?,?,?,?)`
    ).run(
      transferId,
      900_000_001,
      "2025-12-31",
      -800_000,
      `${PREFIX}|retiro`,
      900_000_002,
      "2026-01-07",
      800_000,
      `${PREFIX}|deposito`
    );

    const outEvents = getMergedDepositInflowEventsForAccount(outAccountId);
    expect(outEvents).toContainEqual({ occurred_on: "2025-12-31", amt: -800_000 });

    const inEvents = getMergedDepositInflowEventsForAccount(inAccountId);
    expect(inEvents).toContainEqual({ occurred_on: "2026-01-07", amt: 800_000 });

    db.prepare(`DELETE FROM movements WHERE id = ?`).run(transferId);
  });

  it("unmerged transfers keep the transfer date on both sides", () => {
    const transferId = insertTransfer(outAccountId, inAccountId, 500_000, "2026-02-10");
    expect(getMergedDepositInflowEventsForAccount(outAccountId)).toContainEqual({
      occurred_on: "2026-02-10",
      amt: -500_000,
    });
    expect(getMergedDepositInflowEventsForAccount(inAccountId)).toContainEqual({
      occurred_on: "2026-02-10",
      amt: 500_000,
    });
    db.prepare(`DELETE FROM movements WHERE id = ?`).run(transferId);
  });

  it("cross-month merged retiro is P/L-neutral in both months (no −X/+X couplet)", () => {
    const insVal = db.prepare(
      `INSERT INTO valuations (account_id, as_of_date, value) VALUES (?,?,?)`
    );
    insVal.run(outAccountId, "2025-10-31", 10_000_000);
    insVal.run(outAccountId, "2025-11-30", 10_000_000);
    insVal.run(outAccountId, "2025-12-31", 9_200_000);
    insVal.run(outAccountId, "2026-01-31", 9_200_000);

    const transferId = insertTransfer(outAccountId, inAccountId, 800_000, "2026-01-07");
    db.prepare(
      `INSERT INTO movement_mirror_merges
         (transfer_movement_id, out_movement_id, out_occurred_on, out_amount_clp, out_note,
          in_movement_id, in_occurred_on, in_amount_clp, in_note)
       VALUES (?,?,?,?,?,?,?,?,?)`
    ).run(
      transferId,
      900_000_003,
      "2025-12-31",
      -800_000,
      `${PREFIX}|retiro`,
      900_000_004,
      "2026-01-07",
      800_000,
      `${PREFIX}|deposito`
    );

    const perf = getAccountMonthlyPerformance(outAccountId, "clp");
    const byDate = new Map(perf!.monthly.map((r) => [r.as_of_date, r]));
    const dec = byDate.get("2025-12-31")!;
    const jan = byDate.get("2026-01-31")!;

    expect(dec.net_capital_flow).toBe(-800_000);
    expect(dec.nominal_pl).toBe(0);
    expect(jan.net_capital_flow).toBe(0);
    expect(jan.nominal_pl).toBe(0);

    db.prepare(`DELETE FROM movements WHERE id = ?`).run(transferId);
  });
});

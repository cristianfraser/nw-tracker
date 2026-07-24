import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { db } from "./db.js";
import { getMergedDepositInflowEventsForAccount } from "./accountDeposits.js";
import { getAccountMonthlyPerformance } from "./accountPerformance.js";

/**
 * Mirror-converted transfers carry ONE date, and each side's aportes event must be bucketed on
 * the day THAT side's valuation evidence actually moves:
 *
 * - **month-precision accounts** (cuenta ahorro: sheet months, not real days) keep their
 *   ORIGINAL leg date — a cross-month pair (ahorro retiro 2025-12-31 merged with a checking
 *   deposit on 2026-01-07) would otherwise show a −X/+X monthly P/L couplet;
 * - **every other account** follows the transfer date, because balances and
 *   `transferLegUnitsThroughDate` both key off the movement. Dating a Fintual/APV leg at its
 *   original settlement day instead produced a phantom ±X P/L couplet across the 1–3 day gap.
 */

const PREFIX = "vitest-mirrormergedates";

let outAccountId = 0;
let inAccountId = 0;
let fintualAccountId = 0;

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
  // Real-day account (fondo reserva = Fintual): its units/balance move on the transfer date.
  const reserva = db
    .prepare(`SELECT id FROM asset_groups WHERE slug LIKE '%\\_\\_fondo\\_reserva' ESCAPE '\\' LIMIT 1`)
    .get() as { id: number } | undefined;
  if (!reserva) throw new Error("test DB is missing the fondo_reserva asset group");
  fintualAccountId = Number(ins.run(reserva.id, `${PREFIX}-fintual`).lastInsertRowid);
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

  it("a real-day in-leg (Fintual) uses the TRANSFER date, not its settlement day", () => {
    // Money leaves checking 2026-04-21 and lands at Fintual 2026-04-23; the merged transfer is
    // dated 04-21 and its units count from 04-21, so the aportes event must too — otherwise the
    // bucket reads flow −X on the 21st with no value change (pl +X) and the mirror on the 23rd.
    const transferId = insertTransfer(outAccountId, fintualAccountId, 18_000_000, "2026-04-21");
    db.prepare(
      `INSERT INTO movement_mirror_merges
         (transfer_movement_id, out_movement_id, out_occurred_on, out_amount_clp, out_note,
          in_movement_id, in_occurred_on, in_amount_clp, in_note)
       VALUES (?,?,?,?,?,?,?,?,?)`
    ).run(
      transferId,
      900_000_005,
      "2026-04-21",
      -18_000_000,
      `${PREFIX}|retiro`,
      900_000_006,
      "2026-04-23",
      18_000_000,
      `${PREFIX}|deposito`
    );

    const inEvents = getMergedDepositInflowEventsForAccount(fintualAccountId).filter(
      (e) => e.occurred_on >= "2026-04-19" && e.occurred_on <= "2026-04-25"
    );
    expect(inEvents).toEqual([{ occurred_on: "2026-04-21", amt: 18_000_000 }]);

    // …and the two legs cancel on the same day, so a bucket holding both nets to zero flow.
    const outEvents = getMergedDepositInflowEventsForAccount(outAccountId).filter(
      (e) => e.occurred_on >= "2026-04-19" && e.occurred_on <= "2026-04-25"
    );
    expect(outEvents).toEqual([{ occurred_on: "2026-04-21", amt: -18_000_000 }]);

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

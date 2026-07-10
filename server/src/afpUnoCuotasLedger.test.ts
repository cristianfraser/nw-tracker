import { describe, expect, it } from "vitest";
import { db } from "./db.js";
import { afpCuotasCumulativeThroughDate } from "./afpUnoValuation.js";

describe("AFP cuotas ledger", () => {
  it("Σ units_delta through date, including reconcile-correction rows (they are ledger data)", () => {
    const bucket = db
      .prepare(`SELECT id FROM asset_groups WHERE slug = 'afp' OR slug LIKE '%__afp' LIMIT 1`)
      .get() as { id: number } | undefined;
    expect(bucket).toBeTruthy();

    const insAcc = db.prepare(
      `INSERT INTO accounts (asset_group_id, name, notes, exclude_from_group_totals)
       VALUES (?, 'AFP ledger test', 'import:excel|key=afp-ledger-test', 0)`
    );
    const accountId = Number(insAcc.run(bucket!.id).lastInsertRowid);

    const insMov = db.prepare(
      `INSERT INTO movements (account_id, amount_clp, occurred_on, note, units_delta)
       VALUES (?, ?, ?, ?, ?)`
    );
    insMov.run(accountId, 1, "2017-05-31", "import:excel|cumulative-depositado|Table1-3|AFP|afp-cert:period=2017-05|cuotas=100", 100);
    // A small website-reconcile correction is a normal ledger movement — summed like any other.
    insMov.run(accountId, 1, "2017-06-30", "import:excel|afp-cuotas-website-reconcile|delta=9.08|target=297.84|sum_before=100", 9.08);
    insMov.run(accountId, 1, "2018-01-31", "import:excel|cumulative-depositado|Table1-3|AFP|afp-cert:period=2018-01|cuotas=50", 50);

    expect(afpCuotasCumulativeThroughDate(accountId, "2017-05-31")).toBeCloseTo(100, 4);
    expect(afpCuotasCumulativeThroughDate(accountId, "2017-06-30")).toBeCloseTo(109.08, 4);
    expect(afpCuotasCumulativeThroughDate(accountId, "2026-01-01")).toBeCloseTo(159.08, 4);

    db.prepare(`DELETE FROM accounts WHERE id = ?`).run(accountId);
  });
});

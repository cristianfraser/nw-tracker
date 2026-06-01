import { describe, expect, it } from "vitest";
import { db } from "./db.js";
import {
  afpCuotasCumulativeThroughDate,
  afpCuotasForMarkToMarket,
  afpCuotasLedgerExcludingWebsiteReconcile,
} from "./afpUnoValuation.js";
import { AFP_UNO_WEBSITE_CUOTAS_TARGET } from "./afpModeloPriorCuotasBackfill.js";

describe("AFP cuotas ledger / website-reconcile", () => {
  it("ignores obsolete website-reconcile once cert-backed ledger is populated", () => {
    const bucket = db
      .prepare(`SELECT id FROM asset_groups WHERE slug = 'afp' OR slug LIKE '%__afp' LIMIT 1`)
      .get() as { id: number } | undefined;
    expect(bucket).toBeTruthy();

    const insAcc = db.prepare(
      `INSERT INTO accounts (asset_group_id, name, notes, exclude_from_group_totals)
       VALUES (?, 'AFP reconcile test', 'import:excel|key=afp-reconcile-test', 0)`
    );
    const accountId = Number(insAcc.run(bucket!.id).lastInsertRowid);
    const asOf = "2026-05-29";

    const insMov = db.prepare(
      `INSERT INTO movements (account_id, amount_clp, occurred_on, note, units_delta)
       VALUES (?, ?, ?, ?, ?)`
    );
    insMov.run(
      accountId,
      1,
      "2017-07-31",
      "import:excel|cumulative-depositado|Table1-3|AFP|afp-cert:period=2017-07|cuotas=2.93",
      280
    );
    insMov.run(
      accountId,
      1,
      "2017-06-30",
      `import:excel|afp-cuotas-website-reconcile|delta=291.33|target=${AFP_UNO_WEBSITE_CUOTAS_TARGET}|sum_before=5.13|amount_clp_placeholder=1`,
      291.33
    );

    expect(afpCuotasLedgerExcludingWebsiteReconcile(accountId, asOf)).toBeCloseTo(280, 2);
    expect(afpCuotasCumulativeThroughDate(accountId, asOf)).toBeCloseTo(280, 2);
    expect(afpCuotasCumulativeThroughDate(accountId, asOf)).toBeLessThan(300);

    db.prepare(
      `INSERT INTO valuations (account_id, as_of_date, value_clp, units_snapshot)
       VALUES (?, '2026-04-30', ?, ?)`
    ).run(accountId, 27_000_000, AFP_UNO_WEBSITE_CUOTAS_TARGET);
    expect(afpCuotasForMarkToMarket(accountId, asOf, 96_889)).toBe(AFP_UNO_WEBSITE_CUOTAS_TARGET);

    db.prepare(`DELETE FROM accounts WHERE id = ?`).run(accountId);
  });
});

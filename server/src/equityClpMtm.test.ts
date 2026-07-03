import { describe, expect, it } from "vitest";
import { db } from "./db.js";
import { computeEquityMtmClp } from "./brokerageEquityMtm.js";
import { getAccountPositionMeta } from "./accountPosition.js";
import { accountBucketKindSlug } from "./accountBucket.js";

/**
 * CLP-quoted (.SN) equity MTM: value_clp = units × close, no USD/CLP fx applied.
 * If fx were (incorrectly) applied the value would be off by ~×900, so exact
 * equality against units × close proves the CLP branch.
 */
describe("CLP-quoted equity MTM (.SN)", () => {
  it("computeEquityMtmClp = units × close for a clp ticker; position meta uses close as valor cuota", () => {
    const leaf = db
      .prepare(`SELECT id, slug FROM asset_groups WHERE slug LIKE 'brokerage_acciones__%' LIMIT 1`)
      .get() as { id: number; slug: string } | undefined;
    if (!leaf) return;

    const ticker = "VITEST.SN";
    const accountId = Number(
      db
        .prepare(
          `INSERT INTO accounts (asset_group_id, name, notes, equity_ticker)
           VALUES (?, 'Vitest · clp equity fixture', 'import:panel|ticker=VITEST.SN|key=vitest-clp-equity', ?)`
        )
        .run(leaf.id, ticker).lastInsertRowid
    );
    const movId = Number(
      db
        .prepare(
          `INSERT INTO movements (account_id, amount_clp, occurred_on, note, flow_kind, units_delta)
           VALUES (?, 2_966_600, '2026-01-15', 'vitest-clp-equity-buy', 'stock_buy', 2282)`
        )
        .run(accountId).lastInsertRowid
    );
    db.prepare(
      `INSERT OR REPLACE INTO equity_daily (ticker, trade_date, close, currency) VALUES (?, '2026-01-30', 1300, 'clp')`
    ).run(ticker);
    db.prepare(
      `INSERT OR REPLACE INTO equity_daily (ticker, trade_date, close, currency) VALUES (?, '2026-01-29', 1280, 'clp')`
    ).run(ticker);

    try {
      const mtm = computeEquityMtmClp(accountId, "2026-01-30");
      expect(mtm).not.toBeNull();
      expect(mtm!).toBeCloseTo(2282 * 1300, 6);

      const meta = getAccountPositionMeta(accountId, accountBucketKindSlug(leaf.slug), {
        accountNotes: "import:panel|ticker=VITEST.SN|key=vitest-clp-equity",
        accountName: "Vitest · clp equity fixture",
        afpCuotasAsOfYmd: "2026-01-30",
      });
      expect(meta).not.toBeNull();
      expect(meta!.units!).toBeCloseTo(2282, 9);
      expect(meta!.afp_override_value_clp!).toBeCloseTo(2282 * 1300, 2);
      expect(meta!.afp_override_valor_cuota_clp!).toBeCloseTo(1300, 4);
      expect(meta!.afp_override_value_as_of).toBe("2026-01-30");
    } finally {
      db.prepare(`DELETE FROM equity_daily WHERE ticker = ?`).run(ticker);
      db.prepare(`DELETE FROM movements WHERE id = ?`).run(movId);
      db.prepare(`DELETE FROM accounts WHERE id = ?`).run(accountId);
    }
  });
});

import { afterEach, describe, expect, it, vi } from "vitest";
import { db } from "./db.js";
import { computeEquityMtmClp, computeEquityMtmClpDisplaySync } from "./brokerageEquityMtm.js";
import { getAccountPositionMeta } from "./accountPosition.js";
import { accountBucketKindSlug } from "./accountBucket.js";

afterEach(() => {
  vi.useRealTimers();
});

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
        accountImportKey: "import:panel|ticker=VITEST.SN|key=vitest-clp-equity",
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

  it("display sync uses the Chile calendar day just after midnight (buy dated today counts)", () => {
    const leaf = db
      .prepare(`SELECT id, slug FROM asset_groups WHERE slug LIKE 'brokerage_acciones__%' LIMIT 1`)
      .get() as { id: number; slug: string } | undefined;
    if (!leaf) return;

    const ticker = "VITEST.SN";
    const accountId = Number(
      db
        .prepare(
          `INSERT INTO accounts (asset_group_id, name, notes, equity_ticker)
           VALUES (?, 'Vitest · clp display fixture', 'import:panel|ticker=VITEST.SN|key=vitest-clp-display', ?)`
        )
        .run(leaf.id, ticker).lastInsertRowid
    );
    // Buy dated "today" (Chile 2099-07-03); last close bar is the prior day.
    const movId = Number(
      db
        .prepare(
          `INSERT INTO movements (account_id, amount_clp, occurred_on, note, flow_kind, units_delta)
           VALUES (?, 2_985_000, '2099-07-03', 'vitest-clp-display-buy', 'stock_buy', 2282)`
        )
        .run(accountId).lastInsertRowid
    );
    db.prepare(
      `INSERT OR REPLACE INTO equity_daily (ticker, trade_date, close, currency) VALUES (?, '2099-07-02', 1300, 'clp')`
    ).run(ticker);

    try {
      // 00:30 Chile on Jul 3 = 23:30 Jul 2 in New York: the NYSE display day would still be
      // Jul 2 (0 units → $0); the Santiago display day must be the Chile day (Jul 3).
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2099-07-03T00:30:00-04:00"));
      const sync = computeEquityMtmClpDisplaySync(accountId);
      expect(sync).not.toBeNull();
      expect(sync!.value_clp).toBeCloseTo(2282 * 1300, 6);
      expect(sync!.as_of_date).toBe("2099-07-03");
    } finally {
      vi.useRealTimers();
      db.prepare(`DELETE FROM equity_daily WHERE ticker = ?`).run(ticker);
      db.prepare(`DELETE FROM movements WHERE id = ?`).run(movId);
      db.prepare(`DELETE FROM accounts WHERE id = ?`).run(accountId);
    }
  });
});

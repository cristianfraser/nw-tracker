import { describe, expect, it } from "vitest";
import { db } from "./db.js";
import { getAccountPositionMeta } from "./accountPosition.js";
import { equityTickerForAccount } from "./brokerageEquityMtm.js";
import { accountBucketKindSlug } from "./accountBucket.js";
import { BROKERAGE_SHARE_UNITS_FLOW_KINDS } from "./brokerageFlowMovement.js";

const shareUnitsPh = BROKERAGE_SHARE_UNITS_FLOW_KINDS.map(() => "?").join(", ");

function hasBrokerageShareUnits(accountId: number): boolean {
  return (
    db
      .prepare(
        `SELECT 1 FROM movements
         WHERE account_id = ? AND flow_kind IN (${shareUnitsPh}) AND COALESCE(units_delta, 0) != 0
         LIMIT 1`
      )
      .get(accountId, ...BROKERAGE_SHARE_UNITS_FLOW_KINDS) != null
  );
}

describe("equity brokerage position meta", () => {
  it("returns ticker and units for panel accounts from accounts.equity_ticker", () => {
    // Synthetic fixture: tests must not pick live rows (a sold-out real position made the
    // old first-match picker rot). Panel account + buy movement + EOD price, cleaned up.
    const leaf = db
      .prepare(`SELECT id, slug FROM asset_groups WHERE slug LIKE 'brokerage_acciones__%' LIMIT 1`)
      .get() as { id: number; slug: string } | undefined;
    if (!leaf) return;

    const ticker = "VTEST";
    const accountId = Number(
      db
        .prepare(
          `INSERT INTO accounts (asset_group_id, name, notes, equity_ticker)
           VALUES (?, 'Vitest · panel equity fixture', 'import:panel|ticker=VTEST|key=vitest-equity', ?)`
        )
        .run(leaf.id, ticker).lastInsertRowid
    );
    const movId = Number(
      db
        .prepare(
          `INSERT INTO movements (account_id, amount_clp, occurred_on, note, flow_kind, units_delta, amount_usd)
           VALUES (?, 1_000_000, '2026-01-15', 'vitest-equity-buy', 'stock_buy', 10, 1050)`
        )
        .run(accountId).lastInsertRowid
    );
    db.prepare(
      `INSERT OR IGNORE INTO equity_daily (ticker, trade_date, close, currency) VALUES (?, '2026-01-30', 120, 'usd')`
    ).run(ticker);

    try {
      expect(equityTickerForAccount(accountId)).toBe(ticker);

      const meta = getAccountPositionMeta(accountId, accountBucketKindSlug(leaf.slug), {
        accountImportKey: "import:panel|ticker=VTEST|key=vitest-equity",
        accountName: "Vitest · panel equity fixture",
      });

      expect(meta).not.toBeNull();
      expect(meta!.ticker).toBe(ticker);
      expect(meta!.units).not.toBeNull();
      expect(meta!.units!).toBeCloseTo(10, 9);
      expect(meta!.afp_override_valor_cuota_clp).not.toBeNull();
    } finally {
      db.prepare(`DELETE FROM equity_daily WHERE ticker = ?`).run(ticker);
      db.prepare(`DELETE FROM movements WHERE id = ?`).run(movId);
      db.prepare(`DELETE FROM accounts WHERE id = ?`).run(accountId);
    }
  });

  it("returns ticker and units for legacy SPY/VEA accounts from accounts.equity_ticker", () => {
    const row = db
      .prepare(
        `SELECT a.id, a.name, a.notes, g.slug, a.equity_ticker
         FROM accounts a
         JOIN asset_groups g ON g.id = a.asset_group_id
         WHERE a.notes IN ('import:excel|key=spy', 'import:excel|key=vea')
           AND a.equity_ticker IS NOT NULL
         LIMIT 1`
      )
      .get() as {
      id: number;
      name: string;
      notes: string;
      slug: string;
      equity_ticker: string;
    } | undefined;
    if (!row) return;
    if (!hasBrokerageShareUnits(row.id)) return;

    expect(equityTickerForAccount(row.id)).toBe(row.equity_ticker);

    const slug = accountBucketKindSlug(row.slug);
    const meta = getAccountPositionMeta(row.id, slug, {
      accountImportKey: row.notes,
      accountName: row.name,
    });

    expect(meta).not.toBeNull();
    expect(meta!.ticker).toBe(row.equity_ticker);
    expect(meta!.units).not.toBeNull();
    expect(meta!.units!).toBeGreaterThan(0);
    expect(meta!.afp_override_valor_cuota_clp).not.toBeNull();
  });
});

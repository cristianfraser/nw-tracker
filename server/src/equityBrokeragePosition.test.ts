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
    const row = db
      .prepare(
        `SELECT a.id, a.name, a.notes, g.slug, a.equity_ticker
         FROM accounts a
         JOIN asset_groups g ON g.id = a.asset_group_id
         WHERE a.notes LIKE 'import:panel|ticker=%'
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

    expect(equityTickerForAccount(row.id)).toBe(row.equity_ticker.trim().toUpperCase());

    const slug = accountBucketKindSlug(row.slug);
    const meta = getAccountPositionMeta(row.id, slug, {
      accountNotes: row.notes,
      accountName: row.name,
    });

    expect(meta).not.toBeNull();
    expect(meta!.ticker).toBe(row.equity_ticker.trim().toUpperCase());
    expect(meta!.units).not.toBeNull();
    expect(meta!.units!).toBeGreaterThan(0);
    expect(meta!.afp_override_valor_cuota_clp).not.toBeNull();
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
      accountNotes: row.notes,
      accountName: row.name,
    });

    expect(meta).not.toBeNull();
    expect(meta!.ticker).toBe(row.equity_ticker);
    expect(meta!.units).not.toBeNull();
    expect(meta!.units!).toBeGreaterThan(0);
    expect(meta!.afp_override_valor_cuota_clp).not.toBeNull();
  });
});

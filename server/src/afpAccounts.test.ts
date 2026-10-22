import { afterEach, describe, expect, it } from "vitest";
import { db } from "./db.js";
import { afpUnoAccountIds, listAfpFundAccounts, liveAfpUnoAccountId } from "./afpAccounts.js";
import { AFP_UNO_CUOTA_SERIES_KEY, afpDisplaySeriesKey, parseAfpDisplaySeriesKey } from "./afpUnoSeries.js";
import { cuotaLedgerDisplayTicker, cuotaLedgerSeriesKeyForAccount } from "./cuotaLedgerAccounts.js";

const FIXTURE_PREFIX = "vitest afpAccounts";

function afpBucketId(): number {
  const bucket = db
    .prepare(`SELECT id FROM asset_groups WHERE slug = 'afp' OR slug LIKE '%__afp' LIMIT 1`)
    .get() as { id: number } | undefined;
  if (!bucket) throw new Error("test DB has no afp asset group");
  return bucket.id;
}

function insertAfpAccount(name: string, seriesKey: string | null): number {
  return Number(
    db
      .prepare(
        `INSERT INTO accounts (asset_group_id, name, notes, import_key, fund_series_key, exclude_from_group_totals)
         VALUES (?, ?, ?, ?, ?, 0)`
      )
      .run(afpBucketId(), `${FIXTURE_PREFIX} ${name}`, `test:afp-accounts|${name}`, `test:afp-accounts|${name}`, seriesKey)
      .lastInsertRowid
  );
}

/** The test DB's own afp accounts, set aside while a case needs an exact count. */
function withOtherAfpAccountsHidden<T>(fn: () => T): T {
  const bucket = afpBucketId();
  const others = db
    .prepare(`SELECT id, fund_series_key FROM accounts WHERE asset_group_id = ? AND name NOT LIKE ?`)
    .all(bucket, `${FIXTURE_PREFIX}%`) as { id: number; fund_series_key: string | null }[];
  const park = db.prepare(`UPDATE accounts SET fund_series_key = 'vitest:parked' WHERE id = ?`);
  const restore = db.prepare(`UPDATE accounts SET fund_series_key = ? WHERE id = ?`);
  for (const o of others) park.run(o.id);
  try {
    return fn();
  } finally {
    for (const o of others) restore.run(o.fund_series_key, o.id);
  }
}

afterEach(() => {
  db.prepare(`DELETE FROM accounts WHERE name LIKE ?`).run(`${FIXTURE_PREFIX}%`);
});

describe("afpDisplaySeriesKey", () => {
  it("keys a fund's display series as afp_<afp>_cuota_<fund>", () => {
    expect(afpDisplaySeriesKey("uno", "A")).toBe("afp_uno_cuota_a");
    expect(AFP_UNO_CUOTA_SERIES_KEY).toBe("afp_uno_cuota_a");
    expect(afpDisplaySeriesKey("PlanVital", "a")).toBe("afp_planvital_cuota_a");
    expect(afpDisplaySeriesKey("modelo", "E")).toBe("afp_modelo_cuota_e");
    expect(() => afpDisplaySeriesKey("plan vital", "A")).toThrow(/AFP slug/);
    expect(() => afpDisplaySeriesKey("uno", "F")).toThrow(/fund/);
    expect(() => afpDisplaySeriesKey("uno", "AB")).toThrow(/fund/);
  });

  it("parses a key back and refuses other series", () => {
    expect(parseAfpDisplaySeriesKey("afp_modelo_cuota_a")).toEqual({ afp: "modelo", fund: "A" });
    expect(parseAfpDisplaySeriesKey("afp_prior_funds_a")).toBeNull();
    expect(parseAfpDisplaySeriesKey("afc_cic")).toBeNull();
  });
});

describe("cuotaLedgerSeriesKeyForAccount (afp)", () => {
  it("prices with the series the account declares, UNO Fondo A when the column is empty", () => {
    const planvital = insertAfpAccount("planvital", "afp_planvital_cuota_a");
    const bare = insertAfpAccount("bare", null);
    expect(cuotaLedgerSeriesKeyForAccount(planvital, "afp", "2018-01-31")).toBe("afp_planvital_cuota_a");
    // The date no longer picks the series: the same account, any day.
    expect(cuotaLedgerSeriesKeyForAccount(planvital, "afp", "2026-10-22")).toBe("afp_planvital_cuota_a");
    expect(cuotaLedgerSeriesKeyForAccount(bare, "afp", "2026-10-22")).toBe(AFP_UNO_CUOTA_SERIES_KEY);
  });

  it("names the position ticker after the series", () => {
    expect(cuotaLedgerDisplayTicker("afp", "afp_planvital_cuota_a")).toBe("PLANVITAL-A");
    expect(cuotaLedgerDisplayTicker("afp", "afp_modelo_cuota_a")).toBe("MODELO-A");
    expect(cuotaLedgerDisplayTicker("afp", AFP_UNO_CUOTA_SERIES_KEY)).toBe("UNO-A");
    expect(cuotaLedgerDisplayTicker("afp", null)).toBe("UNO-A");
    expect(cuotaLedgerDisplayTicker("afc", "afc_cic")).toBe("AFC CIC");
    expect(() => cuotaLedgerDisplayTicker("afp", "afp_prior_funds_a")).toThrow(/afp_<afp>_cuota_<fund>/);
  });
});

describe("liveAfpUnoAccountId", () => {
  it("throws when no afp account declares the UNO series", () => {
    withOtherAfpAccountsHidden(() => {
      insertAfpAccount("planvital", "afp_planvital_cuota_a");
      expect(afpUnoAccountIds()).toEqual([]);
      expect(() => liveAfpUnoAccountId()).toThrow(AFP_UNO_CUOTA_SERIES_KEY);
    });
  });

  it("returns the one account on the UNO series, beside the chain's earlier funds", () => {
    withOtherAfpAccountsHidden(() => {
      const planvital = insertAfpAccount("planvital", "afp_planvital_cuota_a");
      const uno = insertAfpAccount("uno", AFP_UNO_CUOTA_SERIES_KEY);
      expect(liveAfpUnoAccountId()).toBe(uno);
      const listed = listAfpFundAccounts().filter((r) => r.name.startsWith(FIXTURE_PREFIX));
      expect(listed.map((r) => [r.id, r.fund_series_key])).toEqual([
        [planvital, "afp_planvital_cuota_a"],
        [uno, AFP_UNO_CUOTA_SERIES_KEY],
      ]);
    });
  });

  it("throws when two afp accounts declare the UNO series", () => {
    withOtherAfpAccountsHidden(() => {
      const a = insertAfpAccount("uno-1", AFP_UNO_CUOTA_SERIES_KEY);
      const b = insertAfpAccount("uno-2", AFP_UNO_CUOTA_SERIES_KEY);
      expect(() => liveAfpUnoAccountId()).toThrow(new RegExp(`2 afp accounts.*${a}, ${b}`));
    });
  });

  it("ignores an account on the UNO series outside the afp kind", () => {
    const other = db
      .prepare(`SELECT id FROM asset_groups WHERE slug LIKE '%cuenta_corriente%' LIMIT 1`)
      .get() as { id: number } | undefined;
    if (!other) return;
    const id = Number(
      db
        .prepare(
          `INSERT INTO accounts (asset_group_id, name, notes, import_key, fund_series_key, exclude_from_group_totals)
           VALUES (?, ?, ?, ?, ?, 0)`
        )
        .run(other.id, `${FIXTURE_PREFIX} not-afp`, "test:afp-accounts|not-afp", "test:afp-accounts|not-afp", AFP_UNO_CUOTA_SERIES_KEY)
        .lastInsertRowid
    );
    expect(afpUnoAccountIds()).not.toContain(id);
  });
});

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db } from "../db.js";
import { isPficInstrument } from "./pfic.js";

const PREFIX = "vitest-pfic";
const ids: number[] = [];

function account(leafSlug: string, key: string, seriesKey: string | null): number {
  const leaf = db.prepare(`SELECT id FROM asset_groups WHERE slug = ?`).get(leafSlug) as { id: number } | undefined;
  if (!leaf) throw new Error(`asset group ${leafSlug} missing`);
  const id = Number(db.prepare(`INSERT INTO accounts (asset_group_id, name, import_key, fund_series_key) VALUES (?, ?, ?, ?)`).run(leaf.id, `${PREFIX} ${key}`, `${PREFIX}|${key}`, seriesKey).lastInsertRowid);
  ids.push(id);
  return id;
}

describe("PFIC holdings", () => {
  let moneyFund = 0;
  let apv = 0;
  let cash = 0;
  beforeAll(() => {
    moneyFund = account("cash_eqs__cash_savings", "money-fund", "vitest_pfic_series");
    apv = account("retirement_apv_a__apv", "apv", "vitest_pfic_apv");
    cash = account("cash_eqs__cash_savings", "cash", null);
  });
  afterAll(() => {
    for (const id of ids) db.prepare(`DELETE FROM accounts WHERE id = ?`).run(id);
  });

  it("treats a peso fund as a PFIC, a plain cash account as none, and an APV as treaty-deferred", () => {
    expect(isPficInstrument(moneyFund)).toBe(true);
    expect(isPficInstrument(cash)).toBe(false);
    expect(isPficInstrument(apv)).toBe(false);
    expect(isPficInstrument(-1)).toBe(false);
  });
});

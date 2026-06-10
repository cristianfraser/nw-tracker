import { afterEach, describe, expect, it } from "vitest";
import { db } from "./db.js";
import {
  maxFxBcentralDateOnOrBefore,
  maxFxDateOnOrBefore,
  upsertFxBcentralRows,
  upsertFxRows,
} from "./sbifSyncDb.js";

afterEach(() => {
  db.exec("DELETE FROM fx_daily");
  db.exec("DELETE FROM fx_daily_bcentral");
});

describe("sbifSyncDb FX tables", () => {
  it("writes Yahoo and BCentral rows to separate tables", () => {
    upsertFxRows([{ date: "2026-06-05", clpPerUsd: 910.29 }], false);
    upsertFxBcentralRows([{ date: "2026-06-05", clpPerUsd: 894.99 }], false);

    const yahoo = db
      .prepare(`SELECT clp_per_usd FROM fx_daily WHERE date = ?`)
      .get("2026-06-05") as { clp_per_usd: number };
    const bcentral = db
      .prepare(`SELECT clp_per_usd FROM fx_daily_bcentral WHERE date = ?`)
      .get("2026-06-05") as { clp_per_usd: number };

    expect(yahoo.clp_per_usd).toBeCloseTo(910.29, 2);
    expect(bcentral.clp_per_usd).toBeCloseTo(894.99, 2);
    expect(maxFxDateOnOrBefore("2026-06-05")).toBe("2026-06-05");
    expect(maxFxBcentralDateOnOrBefore("2026-06-05")).toBe("2026-06-05");
  });
});

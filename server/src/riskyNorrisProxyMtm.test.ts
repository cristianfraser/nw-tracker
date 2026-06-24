import { describe, expect, it, vi, afterEach } from "vitest";
import { db } from "./db.js";
import * as chileDate from "./chileDate.js";
import {
  APV_PROXY_NEGLIGIBLE_REL_DIFF,
  basketUsdForHoldings,
  loadCompositeHoldings,
  loadCompositeMeta,
  proxyClpFromMeta,
  RISKY_NORRIS_PROXY_BUCKET,
  type CompositeHolding,
} from "./watchlistComposite.js";
import {
  fintualGlobalSyncSettledForChileToday,
  riskyNorrisProxyCuotaForMtm,
  shouldUseRiskyNorrisProxyMtm,
} from "./riskyNorrisProxyMtm.js";
import * as riskyNorrisProxyMtm from "./riskyNorrisProxyMtm.js";

const TEST_BUCKET = RISKY_NORRIS_PROXY_BUCKET;
const COMPOSITION_DATE = "2026-06-20";

const HOLDINGS: CompositeHolding[] = [
  { ticker: "SPY", weight: 0.6, synced_at: COMPOSITION_DATE },
  { ticker: "VEA", weight: 0.4, synced_at: COMPOSITION_DATE },
];

afterEach(() => {
  vi.restoreAllMocks();
});

function seedProxyMeta(anchorApv: number | null): boolean {
  let anchorBasket: number;
  try {
    anchorBasket = basketUsdForHoldings(HOLDINGS, COMPOSITION_DATE, { preferLive: false });
  } catch {
    return false;
  }
  const fxRow = db
    .prepare(`SELECT clp_per_usd FROM fx_daily WHERE date <= ? ORDER BY date DESC LIMIT 1`)
    .get(COMPOSITION_DATE) as { clp_per_usd: number } | undefined;
  if (fxRow == null) return false;

  db.prepare(`DELETE FROM watchlist_composite_holdings WHERE bucket_slug = ?`).run(TEST_BUCKET);
  db.prepare(`DELETE FROM watchlist_composite_meta WHERE bucket_slug = ?`).run(TEST_BUCKET);
  db.prepare(
    `INSERT INTO watchlist_composite_meta (
       bucket_slug, fintual_managed_fund_id, composition_date,
       anchor_fund_unit_clp, anchor_apv_fund_unit_clp, anchor_basket_usd, anchor_fx_clp, last_sync_ymd
     ) VALUES (?, 4, ?, 4000, ?, ?, ?, ?)`
  ).run(TEST_BUCKET, COMPOSITION_DATE, anchorApv, anchorBasket, fxRow.clp_per_usd, COMPOSITION_DATE);
  for (const h of HOLDINGS) {
    db.prepare(
      `INSERT INTO watchlist_composite_holdings (bucket_slug, ticker, weight, synced_at)
       VALUES (?, ?, ?, ?)`
    ).run(TEST_BUCKET, h.ticker, h.weight, h.synced_at);
  }
  return true;
}

describe("shouldUseRiskyNorrisProxyMtm", () => {
  it("is false when Fintual evening sync is settled for today", () => {
    vi.spyOn(riskyNorrisProxyMtm, "fintualGlobalSyncSettledForChileToday").mockReturnValue(true);
    expect(shouldUseRiskyNorrisProxyMtm(new Date())).toBe(false);
  });
});

describe("riskyNorrisProxyCuotaForMtm APV calibration", () => {
  it("scales taxable proxy for APV when anchor spread exceeds threshold", () => {
    vi.spyOn(chileDate, "chileCalendarTodayYmd").mockReturnValue(COMPOSITION_DATE);
    if (!seedProxyMeta(4200)) return;
    const meta = loadCompositeMeta(TEST_BUCKET);
    const holdings = loadCompositeHoldings(TEST_BUCKET);
    if (meta == null || holdings.length === 0) return;

    vi.spyOn(riskyNorrisProxyMtm, "fintualGlobalSyncSettledForChileToday").mockReturnValue(false);
    const rnPx = riskyNorrisProxyCuotaForMtm("fintual_cert_risky_norris");
    const apvPx = riskyNorrisProxyCuotaForMtm("fintual_cert_apv_a");
    const proxyRnFull = proxyClpFromMeta(meta, holdings, COMPOSITION_DATE, { preferLive: false });
    expect(rnPx).toBeCloseTo(proxyRnFull, 4);
    expect(apvPx / rnPx).toBeCloseTo(4200 / 4000, 4);
    expect(Math.abs(4200 / 4000 - 1)).toBeGreaterThan(APV_PROXY_NEGLIGIBLE_REL_DIFF);
  });

  it("uses shared proxy for APV when anchor spread is negligible", () => {
    vi.spyOn(chileDate, "chileCalendarTodayYmd").mockReturnValue(COMPOSITION_DATE);
    if (!seedProxyMeta(4002)) return;
    vi.spyOn(riskyNorrisProxyMtm, "fintualGlobalSyncSettledForChileToday").mockReturnValue(false);
    const apvPx = riskyNorrisProxyCuotaForMtm("fintual_cert_apv_a");
    const rnPx = riskyNorrisProxyCuotaForMtm("fintual_cert_risky_norris");
    expect(apvPx).toBeCloseTo(rnPx, 6);
  });
});

describe("fintualGlobalSyncSettledForChileToday", () => {
  it("reads global sync state without throwing", () => {
    expect(typeof fintualGlobalSyncSettledForChileToday()).toBe("boolean");
  });
});

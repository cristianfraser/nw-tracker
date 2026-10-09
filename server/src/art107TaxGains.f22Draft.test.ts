import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { art107DistributionsForYear, art107GainsForYear } from "./art107TaxGains.js";
import { db } from "./db.js";
import { buildF22Draft } from "./f22Draft.js";
import { buildF22Payload } from "./f22DraftPayload.js";
import { foreignShareGainsForYear } from "./foreignShareTaxGains.js";
import { loadOfficialIpcLookup, officialIpcVariationPctBetween } from "./siiOfficialIpc.js";

/**
 * An art. 107 fund (a synthetic `.SN` ticker listed in `art107_instruments`) bought twice and
 * partly sold in a closed income year, plus one distribution: it is taxed apart from foreign
 * shares, its 10% impuesto único reaches 305, and its distribution is the 105 estimate. The
 * reference rows the draft needs (official IPC, December UTM, year-end observado) are inserted
 * only where the test DB has none, and removed afterwards.
 */
const TICKER = "VITESTART107.SN";
const NOTE = "vitest-art107";
const STOCK = "vitest-art107-fund";
const CASH = "vitest-art107-cash";
const TAX_YEAR = 2025;
const INCOME_YEAR = 2024;

const DJ1922_M =
  "M: Detalle de Operaciones y Movimientos / Diferencia Obtenida en el Rescate o Enajenación de Cuotas de Fondos de Inversión que cumplen requisitos Art.107 LIR (Actualizada)";
const DJ1922_AFECTAS =
  "Monto de Distribuciones o Remesas y Devoluciones de Capital, Reajustados ($) / DIVIDENDOS, REMESAS O DISTRIBUCIONES AFECTAS A LOS IMPUESTOS GLOBAL COMPLEMENTARIO Y/O IMPUESTO ADICIONAL";
const DJ1922_CREDIT =
  "AI: Créditos para Impuestos Global Completmentario o Adicional / ACUMULADOS A CONTAR DEL 01.01.2017 / ASOCIADOS A RENTAS AFECTAS / Sin Derecho a Devolución";

describe("art. 107 fund on the F22 draft", () => {
  let stockId = 0;
  let saleId = 0;
  const insertedIpc: string[] = [];
  let insertedUtm = false;
  let insertedObservado = false;

  const cleanup = () => {
    db.prepare(`DELETE FROM movements WHERE note LIKE ?`).run(`${NOTE}%`);
    db.prepare(`DELETE FROM accounts WHERE name IN (?, ?)`).run(STOCK, CASH);
    db.prepare(`DELETE FROM art107_instruments WHERE ticker = ?`).run(TICKER);
    db.prepare(`DELETE FROM equity_daily WHERE ticker = ?`).run(TICKER);
    db.prepare(`DELETE FROM sii_informed_dj WHERE source_file = ?`).run(NOTE);
  };

  beforeAll(() => {
    cleanup();
    const stockLeaf = db.prepare(`SELECT id FROM asset_groups WHERE slug LIKE 'brokerage_acciones__%' LIMIT 1`).get() as
      | { id: number }
      | undefined;
    const cashLeaf = db.prepare(`SELECT id FROM asset_groups WHERE slug LIKE '%__clp' LIMIT 1`).get() as
      | { id: number }
      | undefined;
    if (!stockLeaf || !cashLeaf) throw new Error("test DB: no brokerage stock or CLP cash asset group");

    db.prepare(`INSERT INTO art107_instruments (ticker, kind, note) VALUES (?, 'fund', ?)`).run(TICKER, NOTE);
    const account = db.prepare(`INSERT INTO accounts (asset_group_id, name, equity_ticker) VALUES (?, ?, ?)`);
    stockId = Number(account.run(stockLeaf.id, STOCK, TICKER).lastInsertRowid);
    const cashId = Number(account.run(cashLeaf.id, CASH, null).lastInsertRowid);

    const trade = db.prepare(
      `INSERT INTO movements (account_id, from_account_id, to_account_id, amount, currency, occurred_on, note, units_delta, flow_kind, ticker)
       VALUES (NULL, ?, ?, ?, 'clp', ?, ?, ?, ?, ?)`
    );
    trade.run(cashId, stockId, 1_000_000, "2024-03-15", `${NOTE}|buy1`, 1000, "stock_buy", TICKER);
    trade.run(cashId, stockId, 600_000, "2024-06-10", `${NOTE}|buy2`, 500, "stock_buy", TICKER);
    saleId = Number(
      trade.run(stockId, cashId, 1_500_000, "2024-10-21", `${NOTE}|sell`, 1200, "stock_sell", TICKER).lastInsertRowid
    );
    trade.run(stockId, cashId, 12_345, "2024-11-05", `${NOTE}|distribution`, null, "dividend_payout", TICKER);
    db.prepare(`INSERT INTO equity_daily (ticker, trade_date, close, currency) VALUES (?, '2024-12-30', 1100, 'clp')`).run(TICKER);

    // 0,4% a month, January through November 2024, where the test DB has no official IPC.
    const ipc = db.prepare(
      `INSERT OR IGNORE INTO ipc_official_monthly (month, variation_pct, index_points) VALUES (?, 0.4, ?)`
    );
    for (let m = 1; m <= 11; m++) {
      const month = `2024-${String(m).padStart(2, "0")}-01`;
      if (ipc.run(month, 100 * 1.004 ** m).changes > 0) insertedIpc.push(month);
    }
    insertedUtm = db.prepare(`INSERT OR IGNORE INTO utm_daily (date, utm_clp) VALUES ('2024-12-01', 70000)`).run().changes > 0;
    insertedObservado =
      db.prepare(`INSERT OR IGNORE INTO fx_daily_bcentral (date, clp_per_usd) VALUES ('2024-12-31', 950)`).run().changes > 0;

    const dj = db.prepare(`INSERT INTO sii_informed_dj (tax_year, dj_code, field, value, source_file) VALUES (?, ?, ?, ?, ?)`);
    dj.run(TAX_YEAR, 1922, DJ1922_M, "300.000", NOTE);
    dj.run(TAX_YEAR, 1922, `R: ${DJ1922_AFECTAS} / Con Crédito por IDPC Generados a contar del 01.01.2017`, "0", NOTE);
    dj.run(TAX_YEAR, 1922, `U: ${DJ1922_AFECTAS} / Sin Derecho a Crédito`, "0", NOTE);
    dj.run(TAX_YEAR, 1922, DJ1922_CREDIT, "0", NOTE);
    dj.run(TAX_YEAR, 1891, "C: Montos Informados / Monto Total Ventas", "1.500.000", NOTE);
  });

  afterAll(() => {
    cleanup();
    const ipc = db.prepare(`DELETE FROM ipc_official_monthly WHERE month = ?`);
    for (const month of insertedIpc) ipc.run(month);
    if (insertedUtm) db.prepare(`DELETE FROM utm_daily WHERE date = '2024-12-01'`).run();
    if (insertedObservado) db.prepare(`DELETE FROM fx_daily_bcentral WHERE date = '2024-12-31'`).run();
  });

  // FIFO: the sale takes all 1.000 of the first lot ($1.000.000) and 200 of the second ($240.000).
  const costPaidReajustado = () => {
    const lookup = loadOfficialIpcLookup();
    const pct = (from: string) => officialIpcVariationPctBetween(from, "2024-09-01", lookup);
    return 1_000_000 * (1 + pct("2024-02-01") / 100) + 240_000 * (1 + pct("2024-05-01") / 100);
  };

  it("leaves the fund out of the foreign share sales", () => {
    const foreign = foreignShareGainsForYear(INCOME_YEAR, "fifo", "2026-06-01");
    expect(foreign.disposals.filter((d) => d.accountId === stockId)).toEqual([]);
  });

  it("computes both cost options; lots bought and sold in a closed year take its 31-Dec close", () => {
    const g = art107GainsForYear(INCOME_YEAR, "fifo", "2026-06-01");
    const sale = g.disposals.find((d) => d.movementId === saleId)!;
    expect(sale).toMatchObject({ kind: "fund", ticker: TICKER, units: 1200, proceedsClp: 1_500_000, costClp: 1_240_000, regime: "tax_10pct" });
    expect(sale.costReajustadoClp).toBeCloseTo(costPaidReajustado(), 6);
    expect(sale.costCloseDec31Clp).toBe(1_320_000);
    expect(sale.resultClp.cost_paid).toBeCloseTo(1_500_000 - costPaidReajustado(), 6);
    expect(sale.resultClp.close_dec31).toBe(180_000);
    expect(g.defaultOption).toBe("close_dec31");
    expect(g.byKindClp.fund).toBe(180_000);
    expect(g.inrDisposals).toEqual([]);
    expect(art107DistributionsForYear(INCOME_YEAR).filter((x) => x.accountId === stockId).map((x) => x.amountClp)).toEqual([12_345]);
  });

  it("drafts 1813 → 1816 → 1829 / 1830 outside the IGC, 305 carrying the 10%, and the distribution as the 105 estimate", () => {
    const d = buildF22Draft(TAX_YEAR, "2026-06-01");
    expect(d.base).toBe("informed");
    expect(d.informed[1813]).toBe(300_000);
    expect(d.informed[105]).toBeUndefined();
    expect(d.draft).toMatchObject({ 1813: 180_000, 1809: 0, 1814: 180_000, 1815: 0, 1816: 180_000, 1829: 180_000, 1830: 18_000 });
    expect(d.draft[105]).toBe(12_345);
    expect(d.estimatedCodes).toContain(105);
    expect(d.draft[158]).toBe(12_345);
    expect(d.draft[305]).toBe(d.draft[304]! + 18_000);
    expect(d.art107.carry).toEqual({ clp: 0, source: null });
    expect(d.art107InformedSalesClp).toBe(1_500_000);
    expect(d.art107InformedResultClp).toBe(300_000);
  });

  it("serves the art. 107 block of the page payload", () => {
    const p = buildF22Payload(TAX_YEAR);
    expect(p.art107).toMatchObject({
      lot_method: "fifo",
      provisional: false,
      inr_from: "2027-01-01",
      default_option: "close_dec31",
      result_clp: 180_000,
      carried_loss_clp: 0,
      carried_loss_source: null,
      base_clp: 180_000,
      tax_clp: 18_000,
      informed_sales_clp: 1_500_000,
      informed_result_clp: 300_000,
      distributions: [{ date: "2024-11-05", account_name: STOCK, amount_clp: 12_345 }],
      distributions_clp: 12_345,
    });
    expect(p.art107.sales).toMatchObject([
      { date: "2024-10-21", account_name: STOCK, ticker: TICKER, kind: "fund", units: 1200, cost_close_dec31_clp: 1_320_000, regime: "tax_10pct" },
    ]);
    expect(p.art107.totals_clp.close_dec31).toBe(180_000);
    const row = (code: number) => p.rows.find((r) => r.code === code);
    expect(row(1830)).toMatchObject({ section: "tax", draft: 18_000 });
    expect(row(1813)).toMatchObject({ section: "memo", informed: 300_000, draft: 180_000 });
    expect(row(105)).toMatchObject({ section: "income", draft: 12_345, estimated: true });
  });
});

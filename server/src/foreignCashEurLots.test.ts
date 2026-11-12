import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db } from "./db.js";
import { createPanelAccount } from "./createPanelAccount.js";
import { observadoClpOnOrBefore } from "./bcentralObservado.js";
import { foreignOutflowPesoCostByMovement } from "./foreignCashCostLots.js";
import { foreignCashScope, loadForeignWalkRequests, loadForeignWalkRows } from "./foreignCashLotWalk.js";
import { foreignCashTaxDisposalsFromRows } from "./foreignCashTaxLotEvents.js";
import { foreignFxTaxGainsForYear } from "./f22/foreignFx.js";
import type { OfficialIpcLookup } from "./siiOfficialIpc.js";

/**
 * Euro lots end to end (docs/any-currency-plan.md Phase C2): a euro cash account buys euros with
 * pesos, pays a card in euros and converts some back to pesos. The cost tracer prices the card
 * payment at the pesos those euros cost; the tax lots price everything at the Banco Central's euro
 * observado (`eur_daily`), and the F22 codes take the result.
 */
describe("euro cash lots", () => {
  const NOTE = "vitest-eur-lots";
  const created: { account_id: number; asset_group_id: number; created_leaf_bucket: boolean }[] = [];
  const days = { buy: "2098-03-02", pay: "2098-03-09", back: "2098-03-16" };
  const EUR_OBSERVADO: [string, number][] = [
    [days.buy, 1000],
    [days.pay, 1040],
    [days.back, 1020],
  ];
  let eurId = 0;
  let clpId = 0;
  let payId = 0;

  const insert = (m: {
    from: number;
    to: number;
    amount: number;
    currency: string;
    counter_amount?: number;
    counter_currency?: string;
    date: string;
    flow_kind: string;
  }) =>
    Number(
      db
        .prepare(
          `INSERT INTO movements (from_account_id, to_account_id, amount, currency, counter_amount, counter_currency, occurred_on, note, flow_kind)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(m.from, m.to, m.amount, m.currency, m.counter_amount ?? null, m.counter_currency ?? null, m.date, NOTE, m.flow_kind)
        .lastInsertRowid
    );

  beforeAll(() => {
    const eur = createPanelAccount({
      account: { account_type: "foreign_cash", currency: "eur", name: "Vitest EUR lots", bucket_slug: "cash_savings", category_slug: "vitest_eur_lots", exclude_from_group_totals: true },
    });
    const clp = createPanelAccount({
      account: { account_type: "clp_cash", name: "Vitest EUR lots pesos", bucket_slug: "cash_savings", category_slug: "vitest_eur_lots_pesos", exclude_from_group_totals: true },
    });
    created.push(eur, clp);
    eurId = eur.account_id;
    clpId = clp.account_id;
    for (const [date, clpPerEur] of EUR_OBSERVADO) db.prepare(`INSERT INTO eur_daily (date, clp_per_eur) VALUES (?, ?)`).run(date, clpPerEur);
    // 500 euros for 510.000 pesos; 200 of them pay a card (any account in pesos stands for it here);
    // 100 come back to pesos.
    insert({ from: clpId, to: eurId, amount: 510_000, currency: "clp", counter_amount: 500, counter_currency: "eur", date: days.buy, flow_kind: "fx_exchange" });
    payId = insert({ from: eurId, to: clpId, amount: 200, currency: "eur", date: days.pay, flow_kind: "pago_tarjeta" });
    insert({ from: eurId, to: clpId, amount: 100, currency: "eur", counter_amount: 102_000, counter_currency: "clp", date: days.back, flow_kind: "fx_exchange" });
  });

  afterAll(() => {
    db.prepare(`DELETE FROM movements WHERE note = ?`).run(NOTE);
    for (const [date] of EUR_OBSERVADO) db.prepare(`DELETE FROM eur_daily WHERE date = ?`).run(date);
    for (const c of created) {
      db.prepare(`DELETE FROM accounts WHERE id = ?`).run(c.account_id);
      if (c.created_leaf_bucket) db.prepare(`DELETE FROM asset_groups WHERE id = ?`).run(c.asset_group_id);
    }
  });

  it("reads the euro observado from eur_daily and refuses a currency the Banco Central does not publish", () => {
    expect(observadoClpOnOrBefore("eur", days.pay)).toBe(1040);
    expect(observadoClpOnOrBefore("eur", "2098-03-10")).toBe(1040);
    expect(() => observadoClpOnOrBefore("gbp", days.pay)).toThrow(/publishes no observado for GBP/);
  });

  it("prices a card payment in euros at the pesos those euros cost", () => {
    const cost = foreignOutflowPesoCostByMovement().get(payId)!;
    expect(cost).toMatchObject({ currency: "eur", amount: 200 });
    expect(cost.clp).toBeCloseTo(204_000, 6);
    expect(cost.lots).toEqual([{ source: "purchase", amount: 200, clp: 204_000, movement_id: expect.any(Number) }]);
  });

  const disposalsOf = (purchaseCost: "observado" | "pesos_paid") => {
    const scope = foreignCashScope([eurId]);
    return foreignCashTaxDisposalsFromRows({
      scope,
      rows: loadForeignWalkRows(scope),
      requests: loadForeignWalkRequests(scope),
      eventTimes: new Map(),
      posture: "oficio_2573",
      purchaseCost,
      observadoOn: observadoClpOnOrBefore,
    });
  };

  it("realizes the card payment and the reconversion at the euro observado", () => {
    const { disposals, openLots } = disposalsOf("observado");
    expect(disposals.map((d) => [d.currency, d.units, d.proceeds, d.cost, d.gain, d.tag])).toEqual([
      ["eur", 200, 208_000, 200_000, 8_000, "realized"],
      ["eur", 100, 102_000, 100_000, 2_000, "realized"],
    ]);
    expect(openLots.map((l) => [l.currency, l.units, l.cost])).toEqual([["eur", 200, 200_000]]);
    expect(disposalsOf("pesos_paid").disposals.map((d) => d.cost)).toEqual([204_000, 102_000]);
  });

  it("puts the euro result in the F22 codes", () => {
    // Flat IPC: the December reajuste is 0, so the codes are the nominal result.
    const lookup: OfficialIpcLookup = () => ({ variationPct: 0, indexPoints: 100 });
    const r = foreignFxTaxGainsForYear(
      2098,
      { posture: "oficio_2573", purchaseCost: "observado", route: "idpc_1901", ipc: { latestMonth: "2098-11-01", lookup } },
      () => disposalsOf("observado")
    );
    expect(r.byCurrency).toEqual([{ currency: "eur", disposals: 2, resultClp: 10_000, resultDecemberClp: 10_000, feesLostClp: 0, deferredClp: 0 }]);
    expect(r.codes).toEqual({ 1901: 10_000, idpcClp: 2_500 });
  });
});

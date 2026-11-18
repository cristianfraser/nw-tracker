import { describe, expect, it } from "vitest";
import {
  decodeSeroval,
  racionalDividendRecord,
  racionalMovementsListPage,
  racionalPrintedAmount,
  racionalTradeFill,
  racionalWithdrawalLiquidation,
  serverFnResult,
  stagedRowFromListRow,
} from "./appData.js";
import { racionalListRowKey, racionalRowToMovements, type RacionalScrapedRow } from "./movements.js";

/** Encode plain JSON the way the app's server does (objects, arrays, strings, numbers, booleans, null). */
function encode(value: unknown): unknown {
  let next = 0;
  const walk = (v: unknown): unknown => {
    if (v === null) return { t: 2, s: 0 };
    if (v === true) return { t: 2, s: 2 };
    if (v === false) return { t: 2, s: 3 };
    if (typeof v === "string") return { t: 1, s: v };
    if (typeof v === "number") return { t: 0, s: v };
    if (Array.isArray(v)) return { t: 9, i: next++, a: v.map(walk) };
    const obj = v as Record<string, unknown>;
    const i = next++;
    const keys = Object.keys(obj);
    return { t: 10, i, p: { k: keys, v: keys.map((k) => walk(obj[k])) }, o: 0 };
  };
  return walk(value);
}

const answer = (result: unknown) => encode({ result, error: null, context: {} });

const LIST = {
  userId: "test-user",
  timestamp: "2030-01-10T00:00:00.000Z",
  nextCursor: "c29tZS1jdXJzb3I=",
  data: [
    { id: "20300109_TSTA_0.5_X.1", type: "dividend", status: "complete", label: "Dividendo TSTA", amount: "USD 8,50", amountFormatted: "USD 8,50", currency: "USD", createdAt: "2030-01-09T12:00:00.000Z", assetId: "TSTA" },
    { id: "X.buy-1", type: "stock_buy", status: "complete", label: "Compra TSTA", amount: "USD 1.000,00", amountFormatted: "USD 1.000,00", currency: "USD", createdAt: "2030-01-08T01:30:00.000Z", assetId: "TSTA" },
    { id: "202912", type: "commission", status: "complete", label: "Comisión", amount: "CLP 1.234", amountFormatted: "CLP 1.234", currency: "CLP", createdAt: "2030-01-07T00:00:00.000Z" },
    { id: "u_2030-01-05T15:00:00.000Z_P1_123456", type: "withdrawal", status: "complete", label: "Retiro", amount: "CLP 123.456", amountFormatted: "CLP 123.456", currency: "CLP", createdAt: "2030-01-05T15:00:00.000Z" },
    { id: "corp_X.2_TSTA_2030-01-04T05:00:00.000Z", type: "corporate_action_split", status: "complete", label: "División de acciones TSTA", amount: "USD 0,00", amountFormatted: "USD 0,00", currency: "USD", createdAt: "2030-01-04T05:00:00.000Z", assetId: "TSTA" },
  ],
};

describe("decodeSeroval", () => {
  it("decodes objects, arrays, constants and back-references", () => {
    const shared = { t: 10, i: 2, p: { k: ["x"], v: [{ t: 0, s: 1 }] }, o: 0 };
    const node = {
      t: 10,
      i: 0,
      p: { k: ["a", "b", "c", "d", "e"], v: [{ t: 9, i: 1, a: [shared, { t: 4, i: 2 }] }, { t: 2, s: 2 }, { t: 2, s: 3 }, { t: 2, s: 1 }, { t: 1, s: "s" }] },
    };
    expect(decodeSeroval(node)).toEqual({ a: [{ x: 1 }, { x: 1 }], b: true, c: false, d: null, e: "s" });
  });

  it("throws on a node type it does not know", () => {
    expect(() => decodeSeroval({ t: 17, s: "?" })).toThrow(/unknown node type 17/);
  });

  it("takes the result of an answer and ignores one that carries an error", () => {
    expect(serverFnResult(answer({ ok: 1 }))).toEqual({ ok: 1 });
    expect(serverFnResult(encode({ result: null, error: { message: "no" }, context: {} }))).toBeNull();
    expect(serverFnResult({ plain: "json" })).toBeNull();
  });
});

describe("the movements list", () => {
  const rows = racionalMovementsListPage(serverFnResult(answer(LIST))!).rows.map(stagedRowFromListRow);

  it("stages each row in the print the crawl has always keyed by", () => {
    expect(rows.map((r) => racionalListRowKey(r))).toEqual([
      "2030-01-09|dividends|US$8,50",
      // 01:30 UTC is the evening before in Chile: the app prints, and the row keeps, that day.
      "2030-01-07|buy|US$1.000,00",
      "2030-01-06|commissions|$1.234",
      "2030-01-05|withdrawal|$123.456",
      "2030-01-04|corporate_action|US$0,00",
    ]);
    expect(rows[1]).toMatchObject({ day: "07/01", status: "complete", movement_id: "X.buy-1", api_type: "stock_buy" });
  });

  it("refuses a type it has no mapping for, and an amount in another print", () => {
    const odd = { ...LIST, data: [{ ...LIST.data[0], type: "crypto_swap" }] };
    expect(() => racionalMovementsListPage(serverFnResult(answer(odd))!).rows.map(stagedRowFromListRow)).toThrow(/unmapped movement type "crypto_swap"/);
    expect(() => racionalPrintedAmount("EUR 1,00")).toThrow(/unexpected listed amount/);
  });
});

describe("detail answers", () => {
  const trade = {
    title: "Compra de TSTA",
    assetId: "TSTA",
    type: "stock_buy",
    movementId: "X.buy-1",
    details: {
      title: "Detalle",
      sections: [
        [{ title: "Tipo de orden", value: "Mercado" }],
        [{ title: "Acciones", value: "2,50000000" }, { title: "Precio ejecutado", value: "USD 400,00" }, { title: "Total", value: "USD 1.000,00" }],
        [{ title: "Comisión", value: "USD 0,00" }, { title: "Número de orden", value: "#ORD123", copyToClipboard: true }],
      ],
    },
  };

  it("reads a trade's fill", () => {
    expect(racionalTradeFill(trade, "X.buy-1")).toEqual({ units: "2.50000000", price: 400, commission: 0, order_id: "ORD123", detail_ticker: "TSTA" });
    expect(() => racionalTradeFill(trade, "X.other")).toThrow(/is for "X.buy-1"/);
  });

  it("reads a dividend's breakdown and refuses one that does not add up", () => {
    const div = { id: "20300109_TSTA_0.5_X.1", grossAmount: 10, taxAmount: -1.5, netAmount: 8.5, assetId: "TSTA", createdAt: "2030-01-09T15:00:00.000Z" };
    expect(racionalDividendRecord(div, div.id)).toEqual({
      id: div.id, asset_id: "TSTA", gross: 10, withholding: 1.5, net: 8.5, execution_date: "2030-01-09T15:00:00.000Z", is_interest: false,
    });
    expect(() => racionalDividendRecord({ ...div, netAmount: 9 }, div.id)).toThrow(/net 9/);
  });

  const liquidation = {
    movementId: "u_2030-01-05T15:00:00.000Z_P1_123456",
    type: "portfolio_sell",
    progress: [
      { type: "withdrawal_requested", date: "05/01/2030 12:00" },
      { type: "portfolio_sold", date: "05/01/2030 12:03" },
    ],
    portfolioData: {
      estimatedAssets: [{ assetId: "TESTETF", shares: "100", amount: "CLP 120.000", sharePriceFormatted: "CLP 1.200,00" }],
      cashRemainder: "CLP 3.456",
    },
  };

  it("reads what a portfolio liquidation sold", () => {
    expect(racionalWithdrawalLiquidation(liquidation, liquidation.movementId)).toEqual({
      positions: [{ ticker: "TESTETF", price: 1200, amount: 120000, units: "100" }],
      caja_amount: 3456,
      sale_day: "2030-01-05",
    });
  });

  it("reads a Retiro to a bank as no liquidation, and refuses a liquidation without positions", () => {
    expect(racionalWithdrawalLiquidation({ movementId: "w1", type: "withdrawal" }, "w1")).toBeNull();
    expect(() =>
      racionalWithdrawalLiquidation({ ...liquidation, portfolioData: { estimatedAssets: [] } }, liquidation.movementId),
    ).toThrow(/lists no positions sold/);
  });

  it("decodes into the movements the server books", () => {
    const [div, buy, , retiro, split] = racionalMovementsListPage(serverFnResult(answer(LIST))!).rows.map(stagedRowFromListRow) as RacionalScrapedRow[];
    div!.dividend = racionalDividendRecord(
      { id: div!.movement_id, grossAmount: 10, taxAmount: -1.5, netAmount: 8.5, assetId: "TSTA", createdAt: "2030-01-09T15:00:00.000Z" },
      div!.movement_id!,
    );
    div!.detail_status = "opened";
    buy!.fill = racionalTradeFill(trade, "X.buy-1");
    buy!.detail_status = "opened";
    retiro!.liquidation = racionalWithdrawalLiquidation(liquidation, liquidation.movementId);
    retiro!.detail_status = "opened";

    const [d] = racionalRowToMovements(div!);
    expect(d).toMatchObject({ kind: "dividend", ticker: "TSTA", amount: 8.5, currency: "usd", occurred_on: "2030-01-09", incomplete: null });
    expect(d!.dividend).toMatchObject({ gross: 10, withholding: 1.5 });

    const [b] = racionalRowToMovements(buy!);
    expect(b).toMatchObject({
      kind: "buy", ticker: "TSTA", units: "2.50000000", price: 400, order_id: "ORD123",
      occurred_on: "2030-01-07", occurred_at: "2030-01-08T01:30:00.000Z", incomplete: null,
    });

    expect(racionalRowToMovements(retiro!).map((m) => [m.kind, m.ticker, m.amount, m.units ?? null])).toEqual([
      ["sell", "TESTETF", 120000, "100"],
      ["portfolio_cash_withdrawal", null, 3456, null],
    ]);
    expect(racionalRowToMovements(split!)[0]).toMatchObject({ kind: "corporate_action", amount: 0 });
  });

  it("stages a trade whose detail never arrived as incomplete, not as a trade with no shares", () => {
    const buy = stagedRowFromListRow(racionalMovementsListPage(serverFnResult(answer(LIST))!).rows[1]!);
    buy.detail_status = "unopened";
    buy.detail_error = "the detail of X.buy-1 never arrived within 30s";
    expect(racionalRowToMovements(buy)[0]!.incomplete).toMatch(/share count unknown — the crawl could not open its detail view/);
  });
});

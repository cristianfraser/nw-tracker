import { describe, expect, it } from "vitest";
import {
  normalizeRacionalListRowKey,
  parseRacionalAmount,
  parseRacionalDetail,
  parseRacionalLiquidationDetail,
  racionalListRowKey,
  racionalMovementKind,
  racionalMovementTicker,
  racionalMovementTimestamp,
  racionalRowToMovement,
  racionalRowToMovements,
  sortRacionalMovementsNewestFirst,
} from "./movements.js";
import { racionalApiDividendsFromResponse } from "./movements.js";

/**
 * Fixtures are the real 2026-07-01 SLV purchase read out of the live app, which the ledger
 * already holds as movement 11110 (US$x.xxx,xx / 24,74186066 units) — so the parser is checked
 * against a movement whose correct outcome is known independently.
 */
const SLV_ID = "sw5tfmczKzaeIRvs6jKGJknINRp2_2026-07-01T16:47:29.871Z_1346.17";
/** Real dividend id — ledger movement 11105 (VEA → Racional USD, 2026-06-23, US$x,xx). */
const DIVIDEND_ID = "div_NF.f3bd0707-b9c1-437d-b3d3-6180456630b4_VEA_2026-06-23T10:44:11.025Z";
const SLV_DETAIL =
  "Compraste US$1.346,17 de Silver Trust (SLV). | Progreso | Orden | Creada | 01/07/26 12:47 | " +
  "Tu compra de SLV | Monto comprado | US$1.346,17 | Comisión | US$0,00 | Sin comisión | " +
  "Total orden | US$1.346,17 | Orden #86365B402E0D | Recibiste 24,74186066 acciones de " +
  "Silver Trust (SLV), a un valor de US$54,41 por acción.";

describe("racionalMovements", () => {
  it("reads Chilean amounts and refuses an ambiguous currency", () => {
    expect(parseRacionalAmount("US$1.346,17")).toEqual({ amount: 1346.17, currency: "usd" });
    expect(parseRacionalAmount("$3.000.000")).toEqual({ amount: 3000000, currency: "clp" });
    expect(parseRacionalAmount("US$2,13")).toEqual({ amount: 2.13, currency: "usd" });
    // No prefix → CLP vs USD is a ~900x error, so it must not be guessed.
    expect(() => parseRacionalAmount("1.346,17")).toThrow(/Unexpected Racional amount/);
  });

  it("classifies the app's own taxonomy and rejects anything unmapped", () => {
    expect(racionalMovementKind("Compra SLV")).toBe("buy");
    expect(racionalMovementKind("Venta VEA")).toBe("sell");
    expect(racionalMovementKind("Depósito")).toBe("deposit");
    expect(racionalMovementKind("Retiro")).toBe("withdrawal");
    expect(racionalMovementKind("Dividendo")).toBe("dividend");
    expect(racionalMovementKind("Comisión")).toBe("fee");
    expect(() => racionalMovementKind("Algo Nuevo")).toThrow(/Unmapped Racional movement kind/);
    expect(racionalMovementTicker("Compra SLV")).toBe("SLV");
    expect(racionalMovementTicker("Depósito")).toBeNull();
  });

  it("takes the date from the movement id, not the printed day", () => {
    expect(racionalMovementTimestamp(SLV_ID)).toBe("2026-07-01T16:47:29.871Z");
    // A dividend id ends with the timestamp instead of continuing into an amount.
    expect(racionalMovementTimestamp(DIVIDEND_ID)).toBe("2026-06-23T10:44:11.025Z");
    expect(() => racionalMovementTimestamp("no-timestamp-here")).toThrow(/no ISO timestamp/);
  });

  it("reads a dividend's paying instrument out of its id", () => {
    // The list row is only ever "Dividendo"; the id is what names the holding.
    const m = racionalRowToMovement({
      title: "Dividendo",
      amount: "US$2,13",
      movement_id: DIVIDEND_ID,
    });
    expect(m).toMatchObject({
      kind: "dividend",
      ticker: "VEA",
      occurred_on: "2026-06-23",
      amount: 2.13,
      currency: "usd",
    });
  });

  it("pulls units, price, commission and order id out of the detail panel", () => {
    const d = parseRacionalDetail(SLV_DETAIL);
    // Units stay a decimal STRING — 8 decimals must not round-trip through a float.
    expect(d.units).toBe("24.74186066");
    expect(d.price).toBe(54.41);
    expect(d.commission).toBe(0);
    expect(d.order_id).toBe("86365B402E0D");
    expect(d.detail_ticker).toBe("SLV");
  });

  it("builds the real SLV purchase", () => {
    const m = racionalRowToMovement({
      title: "Compra SLV",
      amount: "US$1.346,17",
      movement_id: SLV_ID,
      detail: SLV_DETAIL,
    });
    expect(m).toMatchObject({
      kind: "buy",
      ticker: "SLV",
      occurred_on: "2026-07-01",
      amount: 1346.17,
      currency: "usd",
      units: "24.74186066",
      price: 54.41,
      order_id: "86365B402E0D",
    });
  });

  it("records a trade listed without its share count as incomplete instead of refusing the row", () => {
    // Refusing is the importer's call, and only for a trade it would have to WRITE — one the
    // ledger already holds needs nothing from its detail view (racionalMovementsImport.test.ts).
    const never = racionalRowToMovement({ title: "Compra SLV", amount: "US$1.346,17", movement_id: SLV_ID });
    expect(never.units).toBeNull();
    expect(never.incomplete).toBe("share count unknown — the crawl never opened its detail view");

    const unopened = racionalRowToMovement({
      title: "Compra VTSYN",
      amount: "US$10,00",
      day: "02/07",
      occurred_on: "2099-07-02",
      kind_class: "buy",
      detail_status: "unopened",
      detail_error: "not among the 10 rendered rows",
    });
    expect(unopened).toMatchObject({ kind: "buy", ticker: "VTSYN", units: null });
    expect(unopened.incomplete).toBe(
      "share count unknown — the crawl could not open its detail view (not among the 10 rendered rows)"
    );

    const opened = racionalRowToMovement({ title: "Compra SLV", amount: "US$1.346,17", movement_id: SLV_ID, detail: SLV_DETAIL });
    expect(opened.incomplete).toBeNull();
    // A cash row never needs its detail view.
    expect(racionalRowToMovement({ title: "Depósito", amount: "$1.000", occurred_on: "2099-07-02" }).incomplete).toBeNull();
  });

  it("marks a dividend without a paying instrument incomplete, and refuses an inconsistent crawl flag", () => {
    const m = racionalRowToMovement({
      title: "Dividendo",
      amount: "US$1,00",
      occurred_on: "2099-07-02",
      kind_class: "dividends",
      detail_status: "unopened",
      detail_error: "the list changed under the click",
    });
    expect(m).toMatchObject({ kind: "dividend", ticker: null });
    expect(m.incomplete).toBe(
      "paying instrument unknown — the crawl could not open its detail view (the list changed under the click)"
    );
    expect(() =>
      racionalRowToMovement({ title: "Compra VTSYN", amount: "US$10,00", occurred_on: "2099-07-02", detail_status: "unopened", detail: "Compraste …" })
    ).toThrow(/flagged unopened but carries a detail text/);
  });

  it("refuses a trade whose list and detail tickers disagree", () => {
    expect(() =>
      racionalRowToMovement({
        title: "Compra VEA",
        amount: "US$1.346,17",
        movement_id: SLV_ID,
        detail: SLV_DETAIL,
      })
    ).toThrow(/ticker mismatch/);
  });

  it("parses a cash deposit without touching the detail path", () => {
    const m = racionalRowToMovement({
      title: "Depósito",
      amount: "$3.000.000",
      movement_id: "uid_2026-07-02T12:00:00.000Z_3000000",
    });
    expect(m).toMatchObject({ kind: "deposit", ticker: null, amount: 3000000, currency: "clp" });
    expect(m.units).toBeNull();
  });

  it("uses the list's own date and kind class for a row the crawl never opened", () => {
    // Racional rows carry no href, so an id costs a click — a cash row is identified entirely
    // from the list: `.movement-type` class plus the day joined to its «Año NNNN» separator.
    const m = racionalRowToMovement({
      title: "Depósito",
      amount: "$3.000.000",
      occurred_on: "2026-07-02",
      kind_class: "contribution",
    });
    expect(m).toMatchObject({ kind: "deposit", occurred_on: "2026-07-02", amount: 3000000 });
    expect(m.movement_id).toBe("2026-07-02|deposit|3000000");
  });

  it("prefers the class over the printed label, and still needs one of date or id", () => {
    const m = racionalRowToMovement({
      title: "Algo Que No Conocemos",
      amount: "US$5,00",
      occurred_on: "2026-07-02",
      kind_class: "dividends",
    });
    expect(m.kind).toBe("dividend");
    expect(() =>
      racionalRowToMovement({ title: "Depósito", amount: "$1.000" })
    ).toThrow(/neither a date nor a movement id/);
  });

  it("orders newest first, which is what the incremental crawl relies on", () => {
    const mk = (iso: string) =>
      racionalRowToMovement({ title: "Depósito", amount: "$1.000", movement_id: `u_${iso}_1000` });
    const sorted = sortRacionalMovementsNewestFirst([
      mk("2026-01-05T00:00:00.000Z"),
      mk("2026-07-01T00:00:00.000Z"),
      mk("2026-03-01T00:00:00.000Z"),
    ]);
    expect(sorted.map((m) => m.occurred_on)).toEqual(["2026-07-01", "2026-03-01", "2026-01-05"]);
  });
});

/**
 * Since 2026-09-23 the crawl pairs each dividend row with its record from Racional's
 * dividends API instead of clicking into it: the record carries the route id, the paying
 * instrument and the gross / withholding behind the credited net.
 */
describe("racionalMovements — dividends API records", () => {
  const record = {
    id: "div_NI.vitest-uuid_VTSOX_2026-09-18T11:56:15.827Z",
    asset_id: "VTSOX",
    gross: 2.75,
    withholding: 0.41,
    net: 2.34,
    execution_date: "2026-09-18T11:56:15.827Z",
    is_interest: false,
  };

  it("takes a dividend row's id and instrument from its API record and carries the breakdown", () => {
    const m = racionalRowToMovement({
      title: "Dividendo",
      amount: "US$2,34",
      occurred_on: "2026-09-18",
      kind_class: "dividends",
      dividend: record,
    });
    expect(m).toMatchObject({
      kind: "dividend",
      ticker: "VTSOX",
      movement_id: record.id,
      occurred_on: "2026-09-18",
      amount: 2.34,
      currency: "usd",
      dividend: record,
    });
  });

  it("refuses a record whose net is not the row's printed amount, or attached to a non-dividend", () => {
    expect(() =>
      racionalRowToMovement({ title: "Dividendo", amount: "US$2,75", occurred_on: "2026-09-18", kind_class: "dividends", dividend: record })
    ).toThrow(/prints 2\.75 usd but its API record .* credited 2\.34/);
    expect(() =>
      racionalRowToMovement({ title: "Depósito", amount: "$1.000", occurred_on: "2026-09-18", kind_class: "contribution", dividend: record })
    ).toThrow(/carries a dividend record but is a deposit/);
  });

  it("parses the raw API response, flips DIVTAX positive and fails fast on a changed shape", () => {
    const raw = {
      dividends: [
        {
          id: record.id,
          assetId: "vtsox",
          amountUSD: 2.34,
          DIV: 2.75,
          DIVTAX: -0.41,
          amount: 2.34,
          executionDate: record.execution_date,
          isInterest: false,
          isRebateInterest: false,
          isUSDDividend: true,
        },
        {
          id: "int-1",
          assetId: "USD",
          amountUSD: 0.05,
          DIV: 0.05,
          DIVTAX: 0,
          amount: 0.05,
          executionDate: "2026-09-01T00:00:00.000Z",
          isInterest: true,
          isRebateInterest: false,
          isUSDDividend: true,
        },
      ],
    };
    const parsed = racionalApiDividendsFromResponse(raw);
    expect(parsed[0]).toEqual(record);
    expect(parsed[1]).toMatchObject({ id: "int-1", withholding: 0, is_interest: true });

    expect(() => racionalApiDividendsFromResponse({ items: [] })).toThrow(/no `dividends` array/);
    expect(() =>
      racionalApiDividendsFromResponse({ dividends: [{ ...raw.dividends[0], DIVTAX: undefined }] })
    ).toThrow(/no numeric DIVTAX/);
    expect(() =>
      racionalApiDividendsFromResponse({ dividends: [{ ...raw.dividends[0], isUSDDividend: false }] })
    ).toThrow(/not a USD dividend/);
    expect(() =>
      racionalApiDividendsFromResponse({ dividends: [{ ...raw.dividends[0], amount: 2.75 }] })
    ).toThrow(/does not add up/);
  });
});

/**
 * 2026-10-20: the «Portafolio IPSA» was liquidated. Racional lists it as one «Retiro» row
 * (class `pending-withdrawal` until the money reaches the wallet two days later, `withdrawal`
 * after) whose detail view prints the positions sold and the caja's pesos. The crawl had set
 * the row aside as a bank withdrawal. Fixture amounts are synthetic; the layout is the real one.
 */
describe("racionalMovements — portfolio liquidation («Retiro»)", () => {
  const RETIRO_DETAIL = [
    "Retiraste $2.640.000 de tu portafolio IPSA.",
    "Progreso",
    "Solicitud de retiro",
    "Creada",
    "19/10/97 23:40",
    "Venta de activos",
    "Completada",
    "20/10/97 15:31",
    "Depósito en billetera",
    "Pendiente",
    "22/10/97",
    "Montos vendidos",
    "ETF IPSA Chile",
    "VTIPSA",
    "$1.300",
    "$2.600.000",
    "2.000 acciones",
    "Además, se retiraron $40.000 de lo que tenías de caja.",
    "El dinero llegará a tu Billetera en 2 días hábiles.",
  ].join("\n");
  const retiroRow = {
    title: "Retiro",
    amount: "$2.640.000",
    day: "19/10",
    occurred_on: "2097-10-19",
    kind_class: "pending-withdrawal",
    status: "pending" as const,
    detail: RETIRO_DETAIL,
    detail_status: "opened" as const,
  };

  it("reads the positions sold, the caja line and the sale day out of the detail view", () => {
    const parsed = parseRacionalLiquidationDetail(RETIRO_DETAIL);
    expect(parsed).toEqual({
      positions: [{ ticker: "VTIPSA", price: 1300, amount: 2600000, units: "2000" }],
      caja_amount: 40000,
      sale_day: "2097-10-20",
    });
    // The same text flattened with pipes (how a detail reads once joined) parses the same.
    expect(parseRacionalLiquidationDetail(RETIRO_DETAIL.replace(/\n/g, " | "))).toEqual(parsed);
    // A plain bank withdrawal prints no «Montos vendidos».
    expect(parseRacionalLiquidationDetail("Retiraste $1.000.000 a tu cuenta bancaria.\nProgreso\nCreada\n19/10/97 10:00")).toBeNull();
    // A section that prints positions in a shape the reader does not know must not pass as a bank withdrawal.
    expect(() => parseRacionalLiquidationDetail("Montos vendidos\nVTIPSA — 2.000 acciones por $2.600.000")).toThrow(/layout changed/);
  });

  it("decodes the row to one sell per position plus the caja's pesos, dated the sale day", () => {
    const movements = racionalRowToMovements(retiroRow);
    expect(movements).toHaveLength(2);
    expect(movements[0]).toMatchObject({
      kind: "sell",
      ticker: "VTIPSA",
      occurred_on: "2097-10-20",
      amount: 2600000,
      currency: "clp",
      units: "2000",
      price: 1300,
      title: "Retiro · venta VTIPSA",
      movement_id: "2097-10-19|withdrawal|2640000#sell:VTIPSA",
      incomplete: null,
    });
    expect(movements[1]).toMatchObject({
      kind: "portfolio_cash_withdrawal",
      ticker: null,
      occurred_on: "2097-10-20",
      amount: 40000,
      currency: "clp",
      units: null,
      title: "Retiro · caja",
      movement_id: "2097-10-19|withdrawal|2640000#caja",
      incomplete: null,
    });
    // The single-movement reader refuses a row that is several.
    expect(() => racionalRowToMovement(retiroRow)).toThrow(/decodes to 2 movements/);
    // Once the money landed the row reads `withdrawal`: the same movements.
    expect(racionalRowToMovements({ ...retiroRow, kind_class: "withdrawal", status: "complete" })).toEqual(movements);
  });

  it("falls back to the list day without a sale step, and skips the caja when it held nothing", () => {
    const noTimeline = RETIRO_DETAIL.split("\n").filter((l) => !/^(Venta de activos|Completada|20\/10\/97 15:31)$/.test(l)).join("\n");
    const [sell, caja] = racionalRowToMovements({ ...retiroRow, detail: noTimeline });
    expect(sell).toMatchObject({ kind: "sell", occurred_on: "2097-10-19" });
    expect(caja).toMatchObject({ kind: "portfolio_cash_withdrawal", occurred_on: "2097-10-19" });

    const emptyCaja = RETIRO_DETAIL.replace(/Además, se retiraron \$40\.000 de lo que tenías de caja\.\n/, "");
    expect(racionalRowToMovements({ ...retiroRow, detail: emptyCaja }).map((m) => m.kind)).toEqual(["sell"]);
  });

  it("keeps a plain bank Retiro as a cash withdrawal, and marks one the crawl never opened incomplete", () => {
    const bank = racionalRowToMovements({
      ...retiroRow,
      amount: "$1.000.000",
      detail: "Retiraste $1.000.000 a tu cuenta bancaria.\nProgreso\nCreada\n19/10/97 10:00",
    });
    expect(bank).toHaveLength(1);
    expect(bank[0]).toMatchObject({ kind: "withdrawal", amount: 1000000, currency: "clp", incomplete: null });

    const unopened = racionalRowToMovement({
      ...retiroRow,
      detail: null,
      detail_status: "unopened",
      detail_error: "the list changed under the click",
    });
    expect(unopened.kind).toBe("withdrawal");
    expect(unopened.incomplete).toBe(
      "whether it liquidated a portfolio or paid a bank account unknown — the crawl could not open its detail view (the list changed under the click)"
    );
    // A Retiro staged before the crawl opened withdrawals (no detail, no flag) is just as undecided.
    expect(racionalRowToMovement({ title: "Retiro", amount: "$1.000", occurred_on: "2097-10-19" }).incomplete).toMatch(
      /^whether it liquidated a portfolio .* the crawl never opened its detail view$/
    );
  });

  it("keys the row without its state, so the cursor survives pending-withdrawal → withdrawal", () => {
    const pending = racionalListRowKey(retiroRow);
    expect(pending).toBe("2097-10-19|withdrawal|$2.640.000");
    expect(racionalListRowKey({ ...retiroRow, kind_class: "withdrawal", status: "complete" })).toBe(pending);
    // A cursor written while keys still carried the state (2026-10-21) is read the same way.
    expect(normalizeRacionalListRowKey("2026-10-20|pending-withdrawal|$1.234.567")).toBe("2026-10-20|withdrawal|$1.234.567");
    expect(normalizeRacionalListRowKey(pending)).toBe(pending);
    // The class decides the kind with its state stripped; «Comisión» rows carry `commissions`.
    expect(racionalRowToMovement({ title: "Comisión", amount: "$2.579", occurred_on: "2097-10-19", kind_class: "commissions" }).kind).toBe("fee");
  });
});

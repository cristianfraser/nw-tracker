import { describe, expect, it } from "vitest";
import {
  parseRacionalAmount,
  parseRacionalDetail,
  racionalMovementKind,
  racionalMovementTicker,
  racionalMovementTimestamp,
  racionalRowToMovement,
  sortRacionalMovementsNewestFirst,
} from "./racionalMovements.js";

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

  it("refuses a trade with no units rather than moving cash without shares", () => {
    expect(() =>
      racionalRowToMovement({ title: "Compra SLV", amount: "US$1.346,17", movement_id: SLV_ID })
    ).toThrow(/missing units or ticker/);
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

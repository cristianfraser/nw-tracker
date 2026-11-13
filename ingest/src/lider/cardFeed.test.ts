import { describe, expect, it } from "vitest";
import { cardUnbilledMovementsKind } from "nw-tracker-contracts";
import {
  liderCardFeedPayload,
  liderDateToIso,
  liderIssuerBalances,
  liderMovementRowToLine,
  type LiderCardFeedFile,
} from "./cardFeed.js";

// Synthetic fixture: made-up merchants, amounts and card digits.
function file(overrides: Partial<LiderCardFeedFile> = {}): LiderCardFeedFile {
  return {
    observed_at: "2026-11-12T21:48:42-03:00",
    card_last4: "9999",
    national: {
      movimiento: [
        { descripcion: "VITEST STORE, SANTIAGO", fecha: "11/11/2026", monto: 12345, tipo: "CLP", cuota: "" },
        { descripcion: "VITEST   *SERVICE  CO", fecha: "10/11/2026", monto: 500000, tipo: "CLP", cuota: "" },
        { descripcion: "PAGO", fecha: "09/11/2026", monto: -400000, tipo: "CLP", cuota: "" },
      ],
    },
    international: {
      movimiento: [{ descripcion: "VITEST ONLINE", fecha: "08/11/2026", monto: "12,34", tipo: "USD", cuota: "" }],
    },
    international_endpoint: "movfacturardolar",
    balances: {
      cupoautpesos: "1000000",
      cupoutilpesos: "112345",
      cupodisppesos: "887655",
      cupoautdolar: "500,00",
      cupoutildolar: "12,34",
      cupodispdolar: "487,66",
    },
    ...overrides,
  };
}

describe("Lider BCI card feed", () => {
  it("decodes national and international lines into one bci card", () => {
    const payload = cardUnbilledMovementsKind.payload.parse(liderCardFeedPayload(file()));
    expect(payload.cards).toHaveLength(1);
    const card = payload.cards[0]!;
    expect(card.account).toEqual({ issuer: "bci", number: "9999" });
    expect(card.close).toBeNull();
    expect(card.lines.map((l) => [l.date, l.merchant, l.currency, l.amount])).toEqual([
      ["2026-11-11", "VITEST STORE, SANTIAGO", "clp", 12345],
      ["2026-11-10", "VITEST *SERVICE CO", "clp", 500000],
      ["2026-11-09", "PAGO", "clp", -400000],
      ["2026-11-08", "VITEST ONLINE", "usd", 12.34],
    ]);
    expect(JSON.parse(card.lines[1]!.raw_text).descripcion).toBe("VITEST   *SERVICE  CO");
    expect(card.lines.every((l) => l.cuota_purchase === undefined)).toBe(true);
  });

  it("states the peso and dollar cupo, dollars with a decimal comma", () => {
    const balances = liderIssuerBalances(file());
    expect(balances).toEqual({
      status: "observed",
      observed_at: "2026-11-12T21:48:42-03:00",
      rows: [
        { account: { issuer: "bci", number: "9999" }, card_last4: "9999", currency: "clp", limit: 1000000, used: 112345, available: 887655 },
        { account: { issuer: "bci", number: "9999" }, card_last4: "9999", currency: "usd", limit: 500, used: 12.34, available: 487.66 },
      ],
    });
  });

  it("sends only the national lines when the international tab was not read", () => {
    const payload = liderCardFeedPayload(file({ international: null, international_error: "tab never answered" }));
    expect(payload.cards[0]!.lines.map((l) => l.currency)).toEqual(["clp", "clp", "clp"]);
  });

  it("takes an empty international list", () => {
    const payload = liderCardFeedPayload(file({ international: { movimiento: [] } }));
    expect(payload.cards[0]!.lines).toHaveLength(3);
  });

  it("reports missing balances as unavailable", () => {
    const payload = cardUnbilledMovementsKind.payload.parse(
      liderCardFeedPayload(file({ balances: null, balances_error: "consultasaldos was not answered" }))
    );
    expect(payload.issuer_balances).toEqual({ status: "unavailable", reason: "consultasaldos was not answered" });
  });

  it("fails fast on rows it cannot read", () => {
    const row = { descripcion: "VITEST", fecha: "01/11/2026", monto: 1000, tipo: "CLP", cuota: "" };
    expect(() => liderMovementRowToLine({ ...row, monto: 0 }, "clp")).toThrow(/non-zero/);
    expect(() => liderMovementRowToLine({ ...row, monto: 10.5 }, "clp")).toThrow(/non-zero/);
    expect(() => liderMovementRowToLine({ ...row, tipo: "EUR" }, "clp")).toThrow(/tipo/);
    expect(() => liderMovementRowToLine({ ...row, tipo: "USD" }, "clp")).toThrow(/clp list holds a usd row/);
    expect(() => liderMovementRowToLine({ ...row, cuota: "01/03" }, "clp")).toThrow(/cuota/);
    expect(() => liderMovementRowToLine({ ...row, fecha: "2026-11-01" }, "clp")).toThrow(/date/);
    expect(() => liderMovementRowToLine({ ...row, fecha: "31/02/2026" }, "clp")).toThrow(/date/);
    expect(() => liderMovementRowToLine({ ...row, descripcion: "  " }, "clp")).toThrow(/descripcion/);
    expect(() => liderMovementRowToLine({ ...row, monto: "abc" }, "clp")).toThrow();
  });

  it("fails fast on a broken file", () => {
    expect(() => liderCardFeedPayload(file({ card_last4: "" }))).toThrow(/last4/);
    expect(() => liderCardFeedPayload(file({ national: {} as never }))).toThrow(/movimiento/);
    expect(() => liderCardFeedPayload(file({ observed_at: "yesterday" }))).toThrow(/observed_at/);
  });

  it("keeps the schema's cupo identity", () => {
    const bad = file({ balances: { ...file().balances!, cupodisppesos: "1" } });
    expect(() => cardUnbilledMovementsKind.payload.parse(liderCardFeedPayload(bad))).toThrow();
  });

  it("reads dd/mm/yyyy dates", () => {
    expect(liderDateToIso("02/06/2026")).toBe("2026-06-02");
  });
});

import { describe, expect, it } from "vitest";
import { extractFundUnitRowsFromQuetalmiJson } from "./afpQuetalmiApi.js";

describe("extractFundUnitRowsFromQuetalmiJson", () => {
  it("reads ISO and dd/mm/yyyy dates, and drops a row whose date is not a date", () => {
    const rows = extractFundUnitRowsFromQuetalmiJson([
      { afp: "UNO", fondo: "A", fecha: "2024-01-02T00:00:00", valor: 58_000.5 },
      { afp: "UNO", fondo: "A", fecha: "03/01/2024", valor: 58_010.25 },
      { afp: "UNO", fondo: "A", fecha: "31/13/2024", valor: 58_020 },
    ]);
    expect(rows.map((r) => [r.day, r.unit_value_clp])).toEqual([
      ["2024-01-02", 58_000.5],
      ["2024-01-03", 58_010.25],
    ]);
  });
});

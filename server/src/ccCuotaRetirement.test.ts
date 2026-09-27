import { afterEach, describe, expect, it } from "vitest";
import { db } from "./db.js";
import {
  clpFacturadoByCloseIso,
  computeCuotaRetirements,
  type CuotaRetirementMonth,
} from "./ccCuotaRetirement.js";

const month = (over: Partial<CuotaRetirementMonth> & { month: string }): CuotaRetirementMonth => ({
  cuota_clp: 0,
  pay_by_iso: `${over.month.slice(0, 7)}-10`,
  close_iso: null,
  facturado_clp: null,
  ...over,
});

describe("computeCuotaRetirements", () => {
  it("no payment evidence → every cuota drops at its pay-by (schedule frame unchanged)", () => {
    const { drops, retired_on_by_month } = computeCuotaRetirements(
      [
        month({ month: "2026-01", cuota_clp: 100_000, pay_by_iso: "2026-02-10", close_iso: "2026-01-22", facturado_clp: 900_000 }),
        month({ month: "2026-02", cuota_clp: 200_000, pay_by_iso: "2026-03-10", close_iso: "2026-02-23", facturado_clp: 800_000 }),
      ],
      []
    );
    expect(drops).toEqual([
      { iso: "2026-02-10", clp: 100_000 },
      { iso: "2026-03-10", clp: 200_000 },
    ]);
    expect(retired_on_by_month.size).toBe(0);
  });

  it("an exact early payment retires the cuota on the payment date", () => {
    const { drops, retired_on_by_month } = computeCuotaRetirements(
      [month({ month: "2026-01", cuota_clp: 100_000, pay_by_iso: "2026-02-10", close_iso: "2026-01-22", facturado_clp: 900_000 })],
      [{ iso: "2026-01-31", clp: 900_000 }]
    );
    expect(drops).toEqual([{ iso: "2026-01-31", clp: 100_000 }]);
    expect(retired_on_by_month.get("2026-01")).toBe("2026-01-31");
  });

  it("a late payment retires late — evidence outranks the pay-by", () => {
    const { drops, retired_on_by_month } = computeCuotaRetirements(
      [month({ month: "2026-01", cuota_clp: 100_000, pay_by_iso: "2026-02-10", close_iso: "2026-01-22", facturado_clp: 900_000 })],
      [{ iso: "2026-02-15", clp: 900_000 }]
    );
    expect(drops).toEqual([{ iso: "2026-02-15", clp: 100_000 }]);
    expect(retired_on_by_month.get("2026-01")).toBe("2026-02-15");
  });

  it("cuotas-first on multi-leg partial payments: the first leg retires the cuota", () => {
    // Feb-2025 shape: facturado 8.xxx.xxx paid 3M + 3M + 2.xxx.xxx; cuota 1.115.824.
    const { drops, retired_on_by_month } = computeCuotaRetirements(
      [month({ month: "2025-02", cuota_clp: 1_115_824, pay_by_iso: "2025-03-10", close_iso: "2025-02-24", facturado_clp: 8_784_951 })],
      [
        { iso: "2025-02-26", clp: 3_000_000 },
        { iso: "2025-03-01", clp: 3_000_000 },
        { iso: "2025-03-10", clp: 2_784_951 },
      ]
    );
    expect(drops).toEqual([{ iso: "2025-02-26", clp: 1_115_824 }]);
    expect(retired_on_by_month.get("2025-02")).toBe("2025-02-26");
  });

  it("a partial first leg smaller than the cuota retires in pieces", () => {
    const { drops, retired_on_by_month } = computeCuotaRetirements(
      [month({ month: "2026-01", cuota_clp: 500_000, pay_by_iso: "2026-02-10", close_iso: "2026-01-22", facturado_clp: 900_000 })],
      [
        { iso: "2026-01-28", clp: 300_000 },
        { iso: "2026-02-03", clp: 600_000 },
      ]
    );
    expect(drops).toEqual([
      { iso: "2026-01-28", clp: 300_000 },
      { iso: "2026-02-03", clp: 200_000 },
    ]);
    expect(retired_on_by_month.get("2026-01")).toBe("2026-02-03");
  });

  it("an evidence hole does not cascade: exact matches claim their own facturación", () => {
    // Oct's payment is missing from evidence; Nov's exact payment must pay NOV, not fill Oct.
    const { drops, retired_on_by_month } = computeCuotaRetirements(
      [
        month({ month: "2025-10", cuota_clp: 400_170, pay_by_iso: "2025-11-10", close_iso: "2025-10-22", facturado_clp: 3_394_140 }),
        month({ month: "2025-11", cuota_clp: 400_168, pay_by_iso: "2025-12-10", close_iso: "2025-11-24", facturado_clp: 2_182_600 }),
      ],
      [{ iso: "2025-11-28", clp: 2_182_600 }]
    );
    expect(drops).toEqual([
      { iso: "2025-11-28", clp: 400_168 },
      { iso: "2025-11-10", clp: 400_170 },
    ]);
    expect(retired_on_by_month.get("2025-11")).toBe("2025-11-28");
    expect(retired_on_by_month.has("2025-10")).toBe(false);
  });

  it("a zero-cuota facturación absorbs its own payment instead of spilling it forward", () => {
    const { drops } = computeCuotaRetirements(
      [
        month({ month: "2025-12", cuota_clp: 0, pay_by_iso: "2026-01-10", close_iso: "2025-12-22", facturado_clp: 1_000_000 }),
        month({ month: "2026-01", cuota_clp: 300_000, pay_by_iso: "2026-02-10", close_iso: "2026-01-22", facturado_clp: 700_000 }),
      ],
      // Non-exact partial payment of December, made after January's close was published.
      [{ iso: "2026-01-25", clp: 900_000 }]
    );
    // December (older, capacity 1M) absorbs it fully; January's cuota stays on schedule.
    expect(drops).toEqual([{ iso: "2026-02-10", clp: 300_000 }]);
  });

  it("payments never attribute to a facturación that has not closed yet", () => {
    const { drops } = computeCuotaRetirements(
      [
        month({ month: "2026-01", cuota_clp: 300_000, pay_by_iso: "2026-02-10", close_iso: "2026-01-22", facturado_clp: null }),
        // Open month: close unknown.
        month({ month: "2026-02", cuota_clp: 250_000, pay_by_iso: "2026-03-10", close_iso: null, facturado_clp: null }),
      ],
      [{ iso: "2026-01-20", clp: 5_000_000 }] // dated before Jan's close — pays neither
    );
    expect(drops).toEqual([
      { iso: "2026-02-10", clp: 300_000 },
      { iso: "2026-03-10", clp: 250_000 },
    ]);
  });

  it("overflow past one facturación's capacity spills only into already-closed months", () => {
    const { drops } = computeCuotaRetirements(
      [
        month({ month: "2026-01", cuota_clp: 100_000, pay_by_iso: "2026-02-10", close_iso: "2026-01-22", facturado_clp: 400_000 }),
        month({ month: "2026-02", cuota_clp: 200_000, pay_by_iso: "2026-03-10", close_iso: "2026-02-23", facturado_clp: 500_000 }),
      ],
      // One big non-exact payment after both closes.
      [{ iso: "2026-02-25", clp: 700_000 }]
    );
    expect(drops).toEqual([
      { iso: "2026-02-25", clp: 100_000 },
      { iso: "2026-02-25", clp: 200_000 },
    ]);
  });

  it("a month with no pay-by and no evidence emits no drop", () => {
    const { drops } = computeCuotaRetirements(
      [month({ month: "2026-01", cuota_clp: 100_000, pay_by_iso: null, close_iso: null, facturado_clp: null })],
      []
    );
    expect(drops).toEqual([]);
  });
});

describe("clpFacturadoByCloseIso", () => {
  let accountId = 0;

  afterEach(() => {
    db.prepare(`DELETE FROM cc_statements WHERE account_id = ?`).run(accountId);
    db.prepare(`DELETE FROM accounts WHERE id = ?`).run(accountId);
  });

  it("keys a statement close through the shared date parser, jammed year repaired", () => {
    const group = db.prepare(`SELECT id FROM asset_groups LIMIT 1`).get() as { id: number };
    accountId = Number(
      db
        .prepare(`INSERT INTO accounts (asset_group_id, name, import_key) VALUES (?, ?, ?)`)
        .run(group.id, "Vitest · retirement close dates", "vitest-cc-retirement-close-dates").lastInsertRowid
    );
    // «25/08/2511»: MCC digits glued onto the year — the parser reads 25/08/25.
    db.prepare(
      `INSERT INTO cc_statements (account_id, card_group, source_pdf, statement_date, layout, currency, monto_facturado)
       VALUES (?, 'A', 'vitest jammed close.pdf', '25/08/2511', 'compact', 'clp', 100000)`
    ).run(accountId);
    expect([...clpFacturadoByCloseIso(accountId)]).toEqual([["2025-08-25", 100_000]]);
  });
});

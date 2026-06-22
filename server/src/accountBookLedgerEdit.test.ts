import { describe, expect, it } from "vitest";
import { bookLedgerEditSchemaForAccount } from "./accountBookLedgerEdit.js";
import { db } from "./db.js";

describe("bookLedgerEditSchemaForAccount", () => {
  it("exposes book ledger edit for AFC", () => {
    const row = db
      .prepare(`SELECT id FROM accounts WHERE notes LIKE 'import:excel|key=afc%' LIMIT 1`)
      .get() as { id: number } | undefined;
    if (!row) return;
    expect(bookLedgerEditSchemaForAccount(row.id)).toEqual({
      valuations: true,
      movements: { units_delta: "optional" },
    });
  });

  it("exposes book ledger edit for cuenta ahorro vivienda", () => {
    const row = db
      .prepare(
        `SELECT id FROM accounts WHERE notes LIKE 'import:excel|key=cuenta_ahorro_vivienda%' LIMIT 1`
      )
      .get() as { id: number } | undefined;
    if (!row) return;
    expect(bookLedgerEditSchemaForAccount(row.id)).not.toBeNull();
  });

  it("returns null for equity MTM (SPY)", () => {
    const row = db
      .prepare(`SELECT id FROM accounts WHERE equity_ticker = 'SPY' LIMIT 1`)
      .get() as { id: number } | undefined;
    if (!row) return;
    expect(bookLedgerEditSchemaForAccount(row.id)).toBeNull();
  });

  it("returns null for AFP", () => {
    const row = db
      .prepare(`SELECT id FROM accounts WHERE notes LIKE 'import:excel|key=afp%' LIMIT 1`)
      .get() as { id: number } | undefined;
    if (!row) return;
    expect(bookLedgerEditSchemaForAccount(row.id)).toBeNull();
  });

  it("returns null for checking (cuenta corriente)", () => {
    const row = db
      .prepare(`SELECT id FROM accounts WHERE notes LIKE 'import:excel|key=cuenta_corriente%' LIMIT 1`)
      .get() as { id: number } | undefined;
    if (!row) return;
    expect(bookLedgerEditSchemaForAccount(row.id)).toBeNull();
  });

  it("returns null for Fintual cert v2", () => {
    const row = db
      .prepare(`SELECT id FROM accounts WHERE notes LIKE 'import:fintual|cert|key=%' LIMIT 1`)
      .get() as { id: number } | undefined;
    if (!row) return;
    expect(bookLedgerEditSchemaForAccount(row.id)).toBeNull();
  });
});

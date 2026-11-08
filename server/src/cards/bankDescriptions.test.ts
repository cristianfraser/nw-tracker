import { describe, expect, it } from "vitest";
import { db } from "../db.js";
import { BANK_DESCRIPTION_RULES, fixedBankDescriptionPattern } from "./bankDescriptionRules.js";
import { bankDescriptionMatchesUnion, bankDescriptionPattern, ownerIdentities } from "./bankDescriptions.js";

describe("bank description rules", () => {
  it("names only known patterns in its unions", () => {
    for (const names of Object.values(BANK_DESCRIPTION_RULES.unions)) {
      for (const n of names) expect(BANK_DESCRIPTION_RULES.patterns).toHaveProperty(n);
    }
  });

  it("reads the owner's own transfers from owner_identity, never a literal", () => {
    // The test database's person (demo generator).
    expect(ownerIdentities("name_pattern").length).toBeGreaterThan(0);
    expect(bankDescriptionPattern("owner_transfer").test("Titular Demo - Santander")).toBe(true);
    expect(bankDescriptionPattern("owner_transfer").test("Otra Persona - Santander")).toBe(false);
    expect(() => fixedBankDescriptionPattern("owner_transfer")).toThrow(/names the owner/);
  });

  it("matches nothing for the owner when no identity is on record", () => {
    const rows = db.prepare(`SELECT kind, value FROM owner_identity`).all() as { kind: string; value: string }[];
    db.prepare(`DELETE FROM owner_identity`).run();
    try {
      expect(bankDescriptionPattern("owner_transfer").test("Titular Demo - Santander")).toBe(false);
      expect(bankDescriptionMatchesUnion("excluded_withdrawal", "Titular Demo - Santander")).toBe(false);
      expect(bankDescriptionMatchesUnion("excluded_withdrawal", "Traspaso Internet a Cuentamática")).toBe(true);
    } finally {
      const ins = db.prepare(`INSERT INTO owner_identity (kind, value) VALUES (?, ?)`);
      for (const r of rows) ins.run(r.kind, r.value);
    }
    expect(bankDescriptionPattern("owner_transfer").test("Titular Demo - Santander")).toBe(true);
  });

  it("keeps the DAP refund bounds and the splittable deposit kinds as data", () => {
    expect(BANK_DESCRIPTION_RULES.dap_abono.max_day_gap).toBeGreaterThan(0);
    expect(BANK_DESCRIPTION_RULES.splittable_deposit_kinds).toContain("fondo_reserva");
  });
});

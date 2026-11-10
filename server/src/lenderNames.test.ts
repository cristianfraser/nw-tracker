import { afterEach, describe, expect, it } from "vitest";
import { db } from "./db.js";
import { foldVendorName } from "./expenseNameText.js";
import { lenderDisplayName } from "./lenderNames.js";

const PREFIX = "Vitest · lender names";
const created: { accounts: number[]; catalog: number[] } = { accounts: [], catalog: [] };

function loan(patterns: readonly string[]): number {
  const group = db.prepare(`SELECT id FROM asset_groups ORDER BY id LIMIT 1`).get() as { id: number };
  const id = Number(db.prepare(`INSERT INTO accounts (asset_group_id, name, notes) VALUES (?, ?, 'vitest')`).run(group.id, `${PREFIX} loan`).lastInsertRowid);
  created.accounts.push(id);
  const ins = db.prepare(`INSERT INTO account_roles (account_id, role, param) VALUES (?, 'lender_pattern', ?)`);
  for (const p of patterns) ins.run(id, p);
  return id;
}

afterEach(() => {
  for (const id of created.catalog.splice(0)) db.prepare(`DELETE FROM vendor_catalog WHERE id = ?`).run(id);
  for (const id of created.accounts.splice(0)) db.prepare(`DELETE FROM accounts WHERE id = ?`).run(id);
});

describe("lenderDisplayName", () => {
  it("spells the lender pattern as a name when the catalog does not know it", () => {
    expect(lenderDisplayName(loan(["HIPOTECARIA VITEST PACIFICO"]))).toBe("Hipotecaria Vitest Pacifico");
  });

  it("takes the vendor catalog's display name for the first pattern it knows", () => {
    created.catalog.push(
      Number(
        db
          .prepare(`INSERT INTO vendor_catalog (match_kind, pattern, display, source) VALUES ('exact', ?, 'Vitest Hipotecaria S.A.', 'user')`)
          .run(foldVendorName("VITEST HIPOTE")).lastInsertRowid
      )
    );
    // The loan was sold on: the first pattern is unknown, the second is the catalog's.
    expect(lenderDisplayName(loan(["VITEST UNKNOWN LENDER", "VITEST HIPOTE"]))).toBe("Vitest Hipotecaria S.A.");
  });

  it("throws for a loan with no lender role", () => {
    expect(() => lenderDisplayName(loan([]))).toThrow(/no lender_pattern role/);
  });
});

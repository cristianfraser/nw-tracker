import { afterAll, describe, expect, it } from "vitest";
import { db } from "./db.js";
import { runExpenseConsumptionBackfill161 } from "./legacyNoteBackfills.js";
import {
  assignPurchaseToRealEstateExpense,
  deleteRealEstateExpenseEntry,
  updateRealEstateExpenseConsumption,
} from "./realEstateExpenseMatching.js";
import { buildRealEstateExpensesPayload, listRealEstateUnlinkedPurchases } from "./flowsRealEstateExpenses.js";

const FIXTURE_ACCOUNT_SLUG = "vitest_apartment";

function ensureFixtureExpenseAccount(): number {
  db.prepare(
    `INSERT OR IGNORE INTO expense_groups (slug, label, sort_order) VALUES ('real_estate', 'Inmuebles', 0)`
  ).run();
  const group = db.prepare(`SELECT id FROM expense_groups WHERE slug = 'real_estate'`).get() as {
    id: number;
  };
  db.prepare(
    `INSERT OR IGNORE INTO expense_accounts (group_id, slug, label, sort_order) VALUES (?, ?, 'Vitest Apartment', 999)`
  ).run(group.id, FIXTURE_ACCOUNT_SLUG);
  const account = db
    .prepare(`SELECT id FROM expense_accounts WHERE group_id = ? AND slug = ?`)
    .get(group.id, FIXTURE_ACCOUNT_SLUG) as { id: number };
  return account.id;
}

function insertFixtureEntry(accountId: number, note: string | null): number {
  const r = db
    .prepare(
      `INSERT INTO expense_entries (amount_clp, spent_on, category, note, expense_account_id)
       VALUES (12345, '2024-05-31', 'gas', ?, ?)`
    )
    .run(note, accountId);
  return Number(r.lastInsertRowid);
}

afterAll(() => {
  const account = db
    .prepare(
      `SELECT a.id FROM expense_accounts a JOIN expense_groups g ON g.id = a.group_id
       WHERE g.slug = 'real_estate' AND a.slug = ?`
    )
    .get(FIXTURE_ACCOUNT_SLUG) as { id: number } | undefined;
  if (account) {
    db.prepare(`DELETE FROM expense_entries WHERE expense_account_id = ?`).run(account.id);
    db.prepare(`DELETE FROM expense_accounts WHERE id = ?`).run(account.id);
  }
});

describe("runExpenseConsumptionBackfill161", () => {
  it("promotes kwh=/m3= note tags to columns and strips them from the note", () => {
    const accountId = ensureFixtureExpenseAccount();
    const entryId = insertFixtureEntry(
      accountId,
      "import:depto-gastos|lastarria|gas|2023-07|m3=10.9|kwh=366"
    );

    runExpenseConsumptionBackfill161(db);

    const row = db
      .prepare(`SELECT kwh, m3, note FROM expense_entries WHERE id = ?`)
      .get(entryId) as { kwh: number | null; m3: number | null; note: string };
    expect(row.kwh).toBe(366);
    expect(row.m3).toBeCloseTo(10.9, 6);
    expect(row.note).toBe("import:depto-gastos|lastarria|gas|2023-07");

    db.prepare(`DELETE FROM expense_entries WHERE id = ?`).run(entryId);
  });

  it("throws on an unparseable tag value", () => {
    const accountId = ensureFixtureExpenseAccount();
    const entryId = insertFixtureEntry(accountId, "import:depto-gastos|x|gas|2023-07|m3=abc");
    expect(() => runExpenseConsumptionBackfill161(db)).toThrow(/invalid tag/);
    db.prepare(`DELETE FROM expense_entries WHERE id = ?`).run(entryId);
  });
});

describe("updateRealEstateExpenseConsumption", () => {
  it("sets and clears m3 on a gas entry", () => {
    const accountId = ensureFixtureExpenseAccount();
    const entryId = insertFixtureEntry(accountId, null);

    updateRealEstateExpenseConsumption(entryId, { kwh: null, m3: 8.5 });
    let row = db.prepare(`SELECT kwh, m3 FROM expense_entries WHERE id = ?`).get(entryId) as {
      kwh: number | null;
      m3: number | null;
    };
    expect(row.kwh).toBeNull();
    expect(row.m3).toBeCloseTo(8.5, 6);

    updateRealEstateExpenseConsumption(entryId, { kwh: null, m3: null });
    row = db.prepare(`SELECT kwh, m3 FROM expense_entries WHERE id = ?`).get(entryId) as {
      kwh: number | null;
      m3: number | null;
    };
    expect(row.kwh).toBeNull();
    expect(row.m3).toBeNull();

    db.prepare(`DELETE FROM expense_entries WHERE id = ?`).run(entryId);
  });

  it("kwh belongs to electricidad, m3 to gas — cross-kind values throw", () => {
    const accountId = ensureFixtureExpenseAccount();
    const gasEntryId = insertFixtureEntry(accountId, null);
    expect(() => updateRealEstateExpenseConsumption(gasEntryId, { kwh: 250, m3: null })).toThrow(
      /kwh belongs to electricidad/
    );

    const luzEntryId = Number(
      db
        .prepare(
          `INSERT INTO expense_entries (amount_clp, spent_on, category, expense_account_id)
           VALUES (12345, '2024-05-31', 'electricidad', ?)`
        )
        .run(accountId).lastInsertRowid
    );
    expect(() => updateRealEstateExpenseConsumption(luzEntryId, { kwh: null, m3: 8.5 })).toThrow(
      /m3 belongs to gas/
    );
    updateRealEstateExpenseConsumption(luzEntryId, { kwh: 250, m3: null });
    const row = db.prepare(`SELECT kwh FROM expense_entries WHERE id = ?`).get(luzEntryId) as {
      kwh: number | null;
    };
    expect(row.kwh).toBe(250);

    db.prepare(`DELETE FROM expense_entries WHERE id IN (?, ?)`).run(gasEntryId, luzEntryId);
  });

  it("rejects negative values and unknown entries", () => {
    const accountId = ensureFixtureExpenseAccount();
    const entryId = insertFixtureEntry(accountId, null);
    expect(() => updateRealEstateExpenseConsumption(entryId, { kwh: -1, m3: null })).toThrow();
    expect(() => updateRealEstateExpenseConsumption(99999999, { kwh: 1, m3: null })).toThrow(
      /not found/
    );
    db.prepare(`DELETE FROM expense_entries WHERE id = ?`).run(entryId);
  });
});

describe("deleteRealEstateExpenseEntry", () => {
  it("deletes the entry and cascades its link row", () => {
    const accountId = ensureFixtureExpenseAccount();
    const entryId = insertFixtureEntry(accountId, null);
    db.prepare(
      `INSERT INTO real_estate_expense_links (expense_entry_id, purchase_key, link_source)
       VALUES (?, 'vitest:fixture-key', 'manual')`
    ).run(entryId);

    deleteRealEstateExpenseEntry(entryId);

    expect(db.prepare(`SELECT 1 FROM expense_entries WHERE id = ?`).get(entryId)).toBeUndefined();
    expect(
      db.prepare(`SELECT 1 FROM real_estate_expense_links WHERE expense_entry_id = ?`).get(entryId)
    ).toBeUndefined();
  });
});

describe("assignPurchaseToRealEstateExpense validation", () => {
  it("rejects unknown kinds", () => {
    expect(() =>
      assignPurchaseToRealEstateExpense({
        purchaseKey: "vitest:whatever",
        accountSlug: FIXTURE_ACCOUNT_SLUG,
        kind: "mortgage",
      })
    ).toThrow(/kind must be one of/);
  });

  it("rejects unknown expense accounts", () => {
    expect(() =>
      assignPurchaseToRealEstateExpense({
        purchaseKey: "vitest:whatever",
        accountSlug: "vitest_no_such_account",
        kind: "rent",
      })
    ).toThrow(/unknown real-estate expense account/);
  });
});

describe("read-only mortgage slots", () => {
  it("null-entry slots are mortgage ledger rows and never linkable", () => {
    const payload = buildRealEstateExpensesPayload();
    const placesWithProperty = new Set(
      payload.places.filter((p) => p.property_account_id != null).map((p) => p.slug)
    );
    for (const slot of payload.slots.filter((s) => s.expense_entry_id == null)) {
      expect(slot.kind).toBe("mortgage");
      expect(placesWithProperty.has(slot.account_slug)).toBe(true);
      expect(slot.can_link).toBe(false);
      expect(slot.link).toBeNull();
      expect(slot.display_amount_clp).toBeGreaterThan(0);
    }
  });
});

describe("listRealEstateUnlinkedPurchases", () => {
  it("excludes already-linked purchases and honors the q filter", () => {
    const linked = new Set(
      (
        db.prepare(`SELECT purchase_key FROM real_estate_expense_links`).all() as {
          purchase_key: string;
        }[]
      ).map((r) => r.purchase_key)
    );
    const all = listRealEstateUnlinkedPurchases({ limit: 50 });
    for (const p of all) {
      expect(linked.has(p.purchase_key)).toBe(false);
    }
    if (all.length > 0) {
      const first = all.find((p) => (p.merchant ?? "").length >= 3);
      if (first) {
        const q = first.merchant!.slice(0, 3);
        const filtered = listRealEstateUnlinkedPurchases({ q, limit: 50 });
        for (const p of filtered) {
          expect(`${p.merchant ?? ""} ${p.origin_label}`.toLowerCase()).toContain(q.toLowerCase());
        }
      }
    }
  });
});

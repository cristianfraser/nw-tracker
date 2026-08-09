import { afterEach, describe, expect, it } from "vitest";
import { db } from "./db.js";
import { markDuplicates, planRacionalMovement } from "./racionalMovementsImport.js";
import { racionalRowToMovement } from "./racionalMovements.js";
import type { RacionalPlannedMovement } from "./racionalMovementsImport.js";

/**
 * Duplicate detection has to survive how the ledger actually looks, which real data showed is
 * not one-row-per-feed-row: the 2026-03-05 VEA purchase the app reports as a single US$xxx,xx
 * line exists as TWO ledger rows that add up to it, and the 2026-03-26 one is recorded at
 * US$xx,xx against the feed's US$54,68. Matching a single row by exact amount misses both and
 * would import a second copy of each.
 */
describe("racionalMovementsImport duplicate detection", () => {
  const created: number[] = [];

  afterEach(() => {
    for (const id of created.splice(0)) {
      db.prepare(`DELETE FROM movements WHERE id = ?`).run(id);
    }
  });

  function twoAccounts(): { from: number; to: number } {
    const rows = db.prepare(`SELECT id FROM accounts ORDER BY id LIMIT 2`).all() as { id: number }[];
    if (rows.length < 2) throw new Error("need two accounts in the test DB");
    return { from: rows[0]!.id, to: rows[1]!.id };
  }

  function seedTransfer(from: number, to: number, amount: number, day = "2026-03-05"): number {
    db.prepare(
      `INSERT INTO movements (from_account_id, to_account_id, amount, currency, occurred_on, note)
       VALUES (?, ?, ?, 'usd', ?, 'vitest-racional')`
    ).run(from, to, amount, day);
    const id = (db.prepare(`SELECT last_insert_rowid() AS id`).get() as { id: number }).id;
    created.push(id);
    return id;
  }

  /** A planned buy with the accounts overridden, so the test needs no real Racional wiring. */
  function plannedBuy(from: number, to: number, amount: number, day = "2026-03-05"): RacionalPlannedMovement {
    const source = racionalRowToMovement({
      title: "Compra VEA",
      amount: `US$${amount.toFixed(2).replace(".", ",")}`,
      occurred_on: day,
      kind_class: "buy",
      detail: `Orden #TEST Recibiste 1,00000000 acciones de Vanguard (VEA), a un valor de US$1,00 por acción.`,
    });
    return {
      source,
      from_account_id: from,
      to_account_id: to,
      account_id: null,
      amount,
      currency: "usd",
      units_delta: "1.00000000",
      flow_kind: "stock_buy",
      note: "vitest",
      duplicate_of: null,
      requires_manual: null,
    };
  }

  it("treats a purchase split across several ledger rows as already imported", () => {
    const { from, to } = twoAccounts();
    const first = seedTransfer(from, to, 264.35);
    seedTransfer(from, to, 64.04); // 264.35 + 64.04 = 328.39

    const [marked] = markDuplicates([plannedBuy(from, to, 328.39)]);
    expect(marked!.duplicate_of).toBe(first);
    expect(marked!.requires_manual).toBeNull();
  });

  it("flags a near-miss for review instead of importing a second copy", () => {
    const { from, to } = twoAccounts();
    const existing = seedTransfer(from, to, 55.22, "2026-03-26");

    const [marked] = markDuplicates([plannedBuy(from, to, 54.68, "2026-03-26")]);
    expect(marked!.duplicate_of).toBeNull();
    expect(marked!.requires_manual).toMatch(/totalling 55\.22 usd vs the feed's 54\.68/);
    expect(marked!.requires_manual).toContain(String(existing));
  });

  it("leaves a genuinely new movement importable", () => {
    const { from, to } = twoAccounts();
    const [marked] = markDuplicates([plannedBuy(from, to, 999.99, "2026-04-17")]);
    expect(marked!.duplicate_of).toBeNull();
    expect(marked!.requires_manual).toBeNull();
  });

  it("never plans cash in or out as an automatic write", () => {
    // The synthetic test DB has no Racional cash account; create the CLP one this needs.
    const group = db.prepare(`SELECT id FROM asset_groups ORDER BY id LIMIT 1`).get() as
      | { id: number }
      | undefined;
    if (!group) return;
    db.prepare(
      `INSERT INTO accounts (asset_group_id, name, exclude_from_group_totals, created_at, import_key)
       VALUES (?, 'vitest Racional CLP', 0, datetime('now'), 'import:panel|kind=clp|key=clp')`
    ).run(group.id);
    const accountId = (db.prepare(`SELECT last_insert_rowid() AS id`).get() as { id: number }).id;

    try {
      for (const [title, kindClass] of [
        ["Depósito", "contribution"],
        ["Retiro", undefined],
      ] as const) {
        const planned = planRacionalMovement(
          racionalRowToMovement({
            title,
            amount: "$1.000.000",
            occurred_on: "2026-07-02",
            kind_class: kindClass,
          })
        );
        // Its counterpart is a real bank movement that arrives via the checking importer.
        expect(planned.requires_manual).toMatch(/mirror-pairs/);
        expect(planned.account_id).toBe(accountId);
      }
    } finally {
      db.prepare(`DELETE FROM accounts WHERE id = ?`).run(accountId);
    }
  });
});

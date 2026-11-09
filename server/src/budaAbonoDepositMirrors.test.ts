import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { listBudaAbonosWithoutRealOutflowLink } from "./budaWallet.js";
import { buildExpenseKey } from "./expenseKeys.js";
import { loadDepositMatchCandidates } from "./checkingCartolaLoaders.js";
import { db } from "./db.js";
import { cartolaCashAccountIdOptional } from "./movementBalanceCashAccounts.js";
import { deleteDepositLinks, insertDepositLink } from "./test/flowFixtures.js";

const BUDA_IMPORT_KEY = "import:buda|key=buda_clp";

let budaId: number | null = null;
let createdBuda = false;
let abonoId: number | null = null;
let corrienteId: number | null = null;
let coinId: number | null = null;

function insertLink(purchaseKey: string): void {
  insertDepositLink({
    account_id: corrienteId!,
    purchase_key: purchaseKey,
    deposit_movement_id: abonoId!,
    payment_clp: 123456,
    amortization_clp: 123456,
    link_source: "auto",
  });
}

/** A checking debit's key: the real outflow a link can name. */
function realDebitKey(): string {
  realDebitId = Number(
    db
      .prepare(`INSERT INTO movements (account_id, amount, currency, occurred_on, note) VALUES (?, -123456, 'clp', '2011-03-04', ?)`)
      .run(corrienteId, "vitest-buda-abono-debit").lastInsertRowid
  );
  return buildExpenseKey({ kind: "checking_mv", movementId: realDebitId, portion: "gastos" });
}
let realDebitId: number | null = null;

beforeAll(() => {
  corrienteId = cartolaCashAccountIdOptional("cuenta_corriente");
  if (corrienteId == null) return;
  const existing = db.prepare(`SELECT id FROM accounts WHERE import_key = ?`).get(BUDA_IMPORT_KEY) as
    | { id: number }
    | undefined;
  if (existing) {
    budaId = existing.id;
  } else {
    const leaf = db
      .prepare(`SELECT id FROM asset_groups WHERE slug = 'brokerage_crypto__buda_clp'`)
      .get() as { id: number } | undefined;
    if (!leaf) return;
    budaId = Number(
      db
        .prepare(`INSERT INTO accounts (asset_group_id, name, notes, import_key) VALUES (?, ?, ?, ?)`)
        .run(leaf.id, "Vitest · Buda CLP", BUDA_IMPORT_KEY, BUDA_IMPORT_KEY).lastInsertRowid
    );
    createdBuda = true;
  }
  const coinLeaf = db
    .prepare(`SELECT id FROM asset_groups WHERE slug LIKE 'brokerage_crypto__%' AND slug != 'brokerage_crypto__buda_clp' LIMIT 1`)
    .get() as { id: number } | undefined;
  if (coinLeaf) {
    coinId = Number(
      db
        .prepare(`INSERT INTO accounts (asset_group_id, name, notes, import_key) VALUES (?, ?, ?, ?)`)
        .run(coinLeaf.id, "Vitest · Buda-funded coin", "vitest-buda-coin", "vitest-buda-coin").lastInsertRowid
    );
    db.prepare(
      `INSERT INTO movements (account_id, amount, currency, occurred_on, note)
       VALUES (?, 123456, 'clp', '2011-03-04', 'vitest-buda-coin-buy')`
    ).run(coinId);
  }
  abonoId = Number(
    db
      .prepare(
        `INSERT INTO movements (account_id, amount, currency, occurred_on, note)
         VALUES (?, 123456, 'clp', '2011-03-04', 'import:buda|abono')`
      )
      .run(budaId).lastInsertRowid
  );
});

afterAll(() => {
  if (abonoId != null) {
    deleteDepositLinks("deposit_movement_id = ?", abonoId);
    db.prepare(`DELETE FROM movements WHERE id = ?`).run(abonoId);
  }
  if (realDebitId != null) db.prepare(`DELETE FROM movements WHERE id = ?`).run(realDebitId);
  if (coinId != null) {
    db.prepare(`DELETE FROM movements WHERE account_id = ?`).run(coinId);
    db.prepare(`DELETE FROM accounts WHERE id = ?`).run(coinId);
  }
  if (createdBuda && budaId != null) db.prepare(`DELETE FROM accounts WHERE id = ?`).run(budaId);
});

describe("listBudaAbonosWithoutRealOutflowLink", () => {
  it("names an abono until a real checking debit is linked to it", () => {
    if (abonoId == null) return;
    expect(listBudaAbonosWithoutRealOutflowLink().has(abonoId)).toBe(true);
    insertLink(realDebitKey());
    expect(listBudaAbonosWithoutRealOutflowLink().has(abonoId)).toBe(false);
    deleteDepositLinks("deposit_movement_id = ?", abonoId);
  });
});

describe("matcher deposit pool with a Buda buffer", () => {
  it("offers the abono, never the same-day coin buy it funded", () => {
    if (abonoId == null || coinId == null) return;
    const pool = loadDepositMatchCandidates();
    expect(pool.some((c) => c.account_id === budaId && c.occurred_on === "2011-03-04")).toBe(true);
    expect(pool.some((c) => c.account_id === coinId)).toBe(false);
  });
});

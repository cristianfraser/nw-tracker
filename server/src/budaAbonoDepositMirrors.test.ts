import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { listBudaAbonosWithoutRealOutflowLink, syncBudaAbonoDepositMirrors } from "./budaWallet.js";
import { checkingGapDepositMirrorPurchaseKey } from "./checkingGapDepositMirrorKey.js";
import { loadDepositMatchCandidates } from "./checkingCartolaLoaders.js";
import { db } from "./db.js";
import { cartolaCashAccountIdOptional } from "./movementBalanceCashAccounts.js";

const BUDA_IMPORT_KEY = "import:buda|key=buda_clp";
const REAL_KEY = "checking-cartola:vitest-buda-abono-debit";

let budaId: number | null = null;
let createdBuda = false;
let abonoId: number | null = null;
let corrienteId: number | null = null;
let coinId: number | null = null;

function mirrorFor(depositId: number): { id: number; amount_clp: number } | undefined {
  return db
    .prepare(`SELECT id, amount_clp FROM checking_gap_deposit_mirrors WHERE deposit_movement_id = ?`)
    .get(depositId) as { id: number; amount_clp: number } | undefined;
}

function insertLink(purchaseKey: string): void {
  db.prepare(
    `INSERT INTO expense_deposit_links
       (account_id, purchase_key, deposit_movement_id, payment_clp, amortization_clp, link_source)
     VALUES (?, ?, ?, 123456, 123456, 'auto')`
  ).run(corrienteId, purchaseKey, abonoId);
}

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
    db.prepare(`DELETE FROM expense_deposit_links WHERE deposit_movement_id = ?`).run(abonoId);
    db.prepare(`DELETE FROM checking_gap_deposit_mirrors WHERE deposit_movement_id = ?`).run(abonoId);
    db.prepare(`DELETE FROM movements WHERE id = ?`).run(abonoId);
  }
  if (coinId != null) {
    db.prepare(`DELETE FROM movements WHERE account_id = ?`).run(coinId);
    db.prepare(`DELETE FROM accounts WHERE id = ?`).run(coinId);
  }
  if (createdBuda && budaId != null) db.prepare(`DELETE FROM accounts WHERE id = ?`).run(budaId);
});

describe("syncBudaAbonoDepositMirrors", () => {
  it("mirrors an abono no real outflow explains, and keeps the mirror's id across syncs", () => {
    if (abonoId == null) return;
    syncBudaAbonoDepositMirrors();
    const first = mirrorFor(abonoId);
    expect(first?.amount_clp).toBe(123456);
    syncBudaAbonoDepositMirrors();
    expect(mirrorFor(abonoId)?.id).toBe(first?.id);
  });

  it("a link from a mirror line is not a real outflow", () => {
    if (abonoId == null) return;
    insertLink(checkingGapDepositMirrorPurchaseKey(987654321));
    expect(listBudaAbonosWithoutRealOutflowLink().has(abonoId)).toBe(true);
    syncBudaAbonoDepositMirrors();
    expect(mirrorFor(abonoId)).toBeDefined();
    db.prepare(`DELETE FROM expense_deposit_links WHERE deposit_movement_id = ?`).run(abonoId);
  });

  it("drops the mirror once the abono is linked to its real cartola debit", () => {
    if (abonoId == null) return;
    insertLink(REAL_KEY);
    expect(listBudaAbonosWithoutRealOutflowLink().has(abonoId)).toBe(false);
    syncBudaAbonoDepositMirrors();
    expect(mirrorFor(abonoId)).toBeUndefined();
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

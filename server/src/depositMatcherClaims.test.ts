import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { db } from "./db.js";
import {
  buildCheckingGastosLines,
  createSplittableInternalTransferPool,
  splitCheckingWithdrawalAgainstDeposits,
} from "./flowsCheckingGastos.js";
import { loadDepositMatchCandidates, type DepositMatchCandidate } from "./checkingCartolaLoaders.js";
import { parseAutoDepositMatchNote } from "./ccExpenseDepositMatchNotes.js";
import { syncCuentaAhorroDepositSplitMirrors, upsertCuentaAhorroDepositSplit } from "./cuentaAhorroDepositSplits.js";
import { cartolaCashAccountIdOptional } from "./movementBalanceCashAccounts.js";

const PREFIX = "vitest-deposit-claims";
const WIRE = "Transf. Internet a otro Bancos";

let corrienteId: number | null = null;
let vistaId: number | null = null;
let ahorroId: number | null = null;
let fundId: number | null = null;
const movementIds: number[] = [];

function insertMovement(sql: string, ...args: unknown[]): number {
  const id = Number(db.prepare(sql).run(...args).lastInsertRowid);
  movementIds.push(id);
  return id;
}

function insertCartolaDebit(accountId: number, occurredOn: string, amountClp: number, idx: number): number {
  const note = `import:cartola|${occurredOn.slice(0, 7)}|401|${WIRE}|on:${occurredOn}|amt:${amountClp}|idx:${idx}`;
  return insertMovement(
    `INSERT INTO movements (account_id, amount, currency, occurred_on, note) VALUES (?, ?, 'clp', ?, ?)`,
    accountId,
    amountClp,
    occurredOn,
    note
  );
}

function insertDeposit(accountId: number, occurredOn: string, amountClp: number): number {
  return insertMovement(
    `INSERT INTO movements (account_id, amount, currency, occurred_on, note) VALUES (?, ?, 'clp', ?, ?)`,
    accountId,
    amountClp,
    occurredOn,
    `${PREFIX}-deposit`
  );
}

function insertTransfer(fromId: number, toId: number, occurredOn: string, amountClp: number): number {
  return insertMovement(
    `INSERT INTO movements (account_id, from_account_id, to_account_id, amount, currency, occurred_on, note)
     VALUES (NULL, ?, ?, ?, 'clp', ?, ?)`,
    fromId,
    toId,
    amountClp,
    occurredOn,
    `${PREFIX}-transfer`
  );
}

beforeAll(() => {
  corrienteId = cartolaCashAccountIdOptional("cuenta_corriente");
  vistaId = cartolaCashAccountIdOptional("cuenta_vista");
  const leaf = db
    .prepare(`SELECT id FROM asset_groups WHERE slug = 'cash_eqs__cuenta_ahorro_vivienda'`)
    .get() as { id: number } | undefined;
  if (leaf) {
    ahorroId = Number(
      db
        .prepare(`INSERT INTO accounts (asset_group_id, name, import_key) VALUES (?, ?, ?)`)
        .run(leaf.id, "Vitest · ahorro", `${PREFIX}-ahorro`).lastInsertRowid
    );
  }
  const fund = db
    .prepare(
      `SELECT a.id FROM accounts a JOIN asset_groups g ON g.id = a.asset_group_id
       WHERE g.slug LIKE 'brokerage_mutual_funds__%' LIMIT 1`
    )
    .get() as { id: number } | undefined;
  fundId = fund?.id ?? null;
  return () => {
    if (ahorroId != null) {
      db.prepare(`DELETE FROM cuenta_ahorro_deposit_splits WHERE deposit_movement_id IN (SELECT id FROM movements WHERE account_id = ?)`).run(ahorroId);
      db.prepare(`DELETE FROM accounts WHERE id = ?`).run(ahorroId);
    }
  };
});

afterEach(() => {
  for (const id of movementIds.splice(0)) {
    db.prepare(`DELETE FROM expense_deposit_links WHERE deposit_movement_id = ?`).run(id);
    db.prepare(`DELETE FROM checking_gap_deposit_mirrors WHERE deposit_movement_id = ?`).run(id);
    db.prepare(`DELETE FROM cuenta_ahorro_deposit_splits WHERE deposit_movement_id = ?`).run(id);
    db.prepare(`DELETE FROM movements WHERE id = ?`).run(id);
  }
});

describe("deposit pool: transfer legs a transfer already pairs with checking", () => {
  it("leaves out a checking → account transfer's to-leg, keeps one from another account", () => {
    if (corrienteId == null || ahorroId == null || fundId == null) return;
    insertTransfer(corrienteId, ahorroId, "2099-05-31", 123_451);
    insertTransfer(fundId, ahorroId, "2099-05-31", 123_452);
    const pool = loadDepositMatchCandidates().filter((d) => d.account_id === ahorroId);
    expect(pool.some((d) => d.amount_clp === 123_451)).toBe(false);
    expect(pool.some((d) => d.amount_clp === 123_452)).toBe(true);
  });
});

describe("month-precision deposits are the fallback", () => {
  const ahorro: DepositMatchCandidate = {
    occurred_on: "2099-05-31",
    amount_clp: 123_453,
    account_id: 900_001,
    category_slug: "cuenta_ahorro_vivienda",
    group_slug: "cash_eqs",
  };
  const abono: DepositMatchCandidate = {
    occurred_on: "2099-05-11",
    amount_clp: 123_453,
    account_id: 900_002,
    category_slug: "buda_clp",
    group_slug: "brokerage",
  };
  const split = (deposits: DepositMatchCandidate[]) =>
    splitCheckingWithdrawalAgainstDeposits(
      { occurred_on: "2099-05-10", amount_clp: -123_453, description: WIRE },
      deposits,
      {
        splittablePool: createSplittableInternalTransferPool(deposits),
        usedDepositKeys: new Set(),
        withdrawalAccountId: 900_003,
        withdrawalCategorySlug: "cuenta_corriente",
      }
    );

  it("a wire with an investment deposit the next day pairs with it, not with the month's ahorro deposit", () => {
    const s = split([ahorro, abono]);
    expect(s.internalClp).toBe(0);
    expect(s.investmentDeposit?.account_id).toBe(900_002);
  });

  it("with no dated counterpart the wire still pairs with the ahorro deposit of its month", () => {
    const s = split([ahorro]);
    expect(s.internalMatchedDeposits.map((a) => a.deposit.account_id)).toEqual([900_001]);
    expect(s.investmentDeposit).toBeNull();
  });
});

describe("a deposit is claimed once across the checking accounts", () => {
  it("a shared claim set lets only one of two same-amount debits pair with the deposit", () => {
    if (corrienteId == null || vistaId == null || ahorroId == null) return;
    insertDeposit(ahorroId, "2099-06-30", 123_454);
    const corrienteDebit = insertCartolaDebit(corrienteId, "2099-06-10", -123_454, 1);
    const vistaDebit = insertCartolaDebit(vistaId, "2099-06-03", -123_454, 1);
    const deposits = loadDepositMatchCandidates();
    const usedDepositKeys = new Set<string>();
    const lines = [corrienteId, vistaId].flatMap((accountId) =>
      buildCheckingGastosLines({ accountId, depositCandidates: deposits, usedDepositKeys })
    );
    const claims = lines.filter(
      (l) =>
        (l.statement_line_id === corrienteDebit || l.statement_line_id === vistaDebit) &&
        parseAutoDepositMatchNote(l.auto_deposit_match_note ?? "").some((seg) => seg.account_id === ahorroId)
    );
    expect(claims.map((l) => l.statement_line_id)).toEqual([corrienteDebit]);
  });
});

describe("ahorro split mirrors", () => {
  function mirrorAmount(depositId: number): number | undefined {
    return (
      db.prepare(`SELECT amount_clp FROM checking_gap_deposit_mirrors WHERE deposit_movement_id = ?`).get(depositId) as
        | { amount_clp: number }
        | undefined
    )?.amount_clp;
  }
  function link(depositId: number, purchaseKey: string, amount: number): void {
    db.prepare(
      `INSERT INTO expense_deposit_links
         (account_id, purchase_key, deposit_movement_id, payment_clp, amortization_clp, link_source)
       VALUES (?, ?, ?, ?, ?, 'auto')`
    ).run(corrienteId, purchaseKey, depositId, amount, amount);
  }

  it("mirror only the self-funded pesos no real checking link explains", () => {
    if (corrienteId == null || ahorroId == null) return;
    const deposit = insertDeposit(ahorroId, "2099-07-31", 300_000);
    upsertCuentaAhorroDepositSplit(deposit, 300_000, PREFIX);
    syncCuentaAhorroDepositSplitMirrors();
    expect(mirrorAmount(deposit)).toBe(300_000);

    link(deposit, `${PREFIX}:partial`, 100_000);
    syncCuentaAhorroDepositSplitMirrors();
    expect(mirrorAmount(deposit)).toBe(200_000);

    link(deposit, "synthetic-checking-gap-mirror:987654321", 200_000);
    syncCuentaAhorroDepositSplitMirrors();
    expect(mirrorAmount(deposit)).toBe(200_000);

    link(deposit, `${PREFIX}:rest`, 200_000);
    syncCuentaAhorroDepositSplitMirrors();
    expect(mirrorAmount(deposit)).toBeUndefined();
  });
});

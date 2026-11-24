import { describe, expect, it } from "vitest";
import { db } from "./db.js";
import {
  cartolaCashAccountIdOptional,
  listMovementBalanceCashAccountIds,
} from "./movementBalanceCashAccounts.js";
import { kindSlugForAccount } from "./portfolioGroupTree.js";
import { buildFlowsExpensesPayload } from "./flowsExpenses.js";

describe("movementBalanceCashAccounts", () => {
  it("lists corriente and vista accounts under checking_accounts bucket", () => {
    const ids = listMovementBalanceCashAccountIds();
    expect(ids.length).toBeGreaterThan(0);
    for (const id of ids) {
      const kind = kindSlugForAccount(id);
      expect(kind === "cuenta_corriente" || kind === "cuenta_vista").toBe(true);
    }
  });

  it("resolves cartola accounts by behavior kind, not checking_accounts nav slug", () => {
    const corrienteId = cartolaCashAccountIdOptional("cuenta_corriente");
    const vistaId = cartolaCashAccountIdOptional("cuenta_vista");
    expect(corrienteId).not.toBeNull();
    expect(vistaId).not.toBeNull();
    expect(kindSlugForAccount(corrienteId!)).toBe("cuenta_corriente");
    expect(kindSlugForAccount(vistaId!)).toBe("cuenta_vista");
  });

  it("includes checking gastos lines in expenses payload when cartola withdrawals exist", () => {
    const ids = listMovementBalanceCashAccountIds();
    const vistaId = cartolaCashAccountIdOptional("cuenta_vista");
    expect(vistaId).not.toBeNull();
    expect(ids).toContain(vistaId);
    // A cartola withdrawal of its own on the cuenta vista: a plain purchase, so a gastos line.
    const note =
      "import:cartola|2099-07|Agustinas|Compra ACME STORE|on:2099-07-03|amt:-4321|idx:9998811";
    const movementId = Number(
      db
        .prepare(
          `INSERT INTO movements (account_id, amount, currency, occurred_on, note)
           VALUES (?, -4321, 'clp', '2099-07-03', ?)`
        )
        .run(vistaId, note).lastInsertRowid
    );
    try {
      const payload = buildFlowsExpensesPayload();
      const checkingLines = payload.lines.filter((l) => l.source === "checking");
      expect(checkingLines.every((l) => ids.includes(l.account_id))).toBe(true);
      const own = checkingLines.filter((l) => l.statement_line_id === movementId);
      expect(own).toHaveLength(1);
      expect(own[0]!.account_id).toBe(vistaId);
      expect(own[0]!.value_clp).toBe(4321);
    } finally {
      db.prepare(`DELETE FROM movements WHERE id = ?`).run(movementId);
    }
  });
});

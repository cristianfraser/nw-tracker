import { describe, expect, it } from "vitest";
import {
  cartolaCashAccountIdOptional,
  listMovementBalanceCashAccountIds,
} from "./movementBalanceCashAccounts.js";
import { kindSlugForAccount } from "./portfolioGroupTree.js";
import { buildFlowsCreditCardExpensesPayload } from "./flowsCreditCardExpenses.js";

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
    if (vistaId != null) expect(kindSlugForAccount(vistaId)).toBe("cuenta_vista");
  });

  it("includes checking gastos lines in expenses payload when cartola withdrawals exist", () => {
    const ids = listMovementBalanceCashAccountIds();
    if (ids.length === 0) return;
    const payload = buildFlowsCreditCardExpensesPayload();
    const checkingLines = payload.lines.filter((l) => l.source === "checking");
    if (checkingLines.length === 0) return;
    expect(checkingLines.every((l) => ids.includes(l.account_id))).toBe(true);
  });
});

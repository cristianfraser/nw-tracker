import { describe, expect, it } from "vitest";
import {
  checkingCreditLooksLikeBudaRetiro,
  checkingCreditMatchesBudaRetiro,
} from "./budaWallet.js";
import type { DepositMatchCandidate } from "./flowsCheckingGastos.js";

const BUDA_ID = 97;
const budaRetiro = (occurred_on: string, amount_clp: number): DepositMatchCandidate => ({
  occurred_on,
  amount_clp,
  account_id: BUDA_ID,
  category_slug: "buda_clp",
  group_slug: "brokerage",
});

function creditNote(occurred_on: string, amount: number, description: string): string {
  return `import:cartola|${occurred_on.slice(0, 7)}|Agustinas|${description}|doc:6001125|on:${occurred_on}|amt:${amount}|idx:1`;
}

describe("budaWallet retiro recognition", () => {
  it("recognises Buda's commercial names in checking inflows", () => {
    expect(checkingCreditLooksLikeBudaRetiro("0764155289 Transf. BUDA COM SPA")).toBe(true);
    expect(checkingCreditLooksLikeBudaRetiro("Agustinas 0764155289 Transf. SURBTC SPA")).toBe(true);
    // Bare transfers without Buda's name are not a reliable signal.
    expect(checkingCreditLooksLikeBudaRetiro("0764155289 Transf.")).toBe(false);
    expect(checkingCreditLooksLikeBudaRetiro("0768106274 Transf. Fintual AGF")).toBe(false);
  });

  it("pairs a Buda withdrawal inflow with a same-amount Buda retiro and consumes the key", () => {
    const outflows = [budaRetiro("2025-02-03", 3_000_000), budaRetiro("2025-03-10", 2_000_000)];
    const consumed = new Set<string>();
    const matched = checkingCreditMatchesBudaRetiro(
      {
        occurred_on: "2025-02-04",
        amount_clp: 3_000_000,
        note: creditNote("2025-02-04", 3_000_000, "0764155289 Transf. BUDA COM SPA"),
      },
      outflows,
      { budaAccountId: BUDA_ID, consumedLedgerOutflowKeys: consumed }
    );
    expect(matched).toBe(true);
    expect([...consumed]).toEqual(["97|2025-02-03|3000000"]);
  });

  it("does not double-consume the same retiro for two Buda inflows", () => {
    const outflows = [budaRetiro("2025-02-03", 3_000_000)];
    const consumed = new Set<string>();
    const args = {
      occurred_on: "2025-02-04",
      amount_clp: 3_000_000,
      note: creditNote("2025-02-04", 3_000_000, "0764155289 Transf. BUDA COM SPA"),
    };
    expect(checkingCreditMatchesBudaRetiro(args, outflows, { budaAccountId: BUDA_ID, consumedLedgerOutflowKeys: consumed })).toBe(true);
    expect(checkingCreditMatchesBudaRetiro(args, outflows, { budaAccountId: BUDA_ID, consumedLedgerOutflowKeys: consumed })).toBe(false);
  });

  it("only matches retiros on the Buda buffer account", () => {
    const otherAccountRetiro: DepositMatchCandidate = { ...budaRetiro("2025-02-03", 3_000_000), account_id: 45 };
    const matched = checkingCreditMatchesBudaRetiro(
      {
        occurred_on: "2025-02-04",
        amount_clp: 3_000_000,
        note: creditNote("2025-02-04", 3_000_000, "0764155289 Transf. BUDA COM SPA"),
      },
      [otherAccountRetiro],
      { budaAccountId: BUDA_ID, consumedLedgerOutflowKeys: new Set() }
    );
    expect(matched).toBe(false);
  });

  it("requires the inflow to fall on or after the retiro within the window", () => {
    const outflows = [budaRetiro("2025-02-10", 3_000_000)];
    // Credit before the retiro date is not a return of that retiro.
    expect(
      checkingCreditMatchesBudaRetiro(
        {
          occurred_on: "2025-02-04",
          amount_clp: 3_000_000,
          note: creditNote("2025-02-04", 3_000_000, "0764155289 Transf. BUDA COM SPA"),
        },
        outflows,
        { budaAccountId: BUDA_ID, consumedLedgerOutflowKeys: new Set() }
      )
    ).toBe(false);
  });
});

import { describe, expect, it } from "vitest";
import { db } from "./db.js";
import { checkingAccountId } from "./checkingCartolaImport.js";
import {
  buildFintualIncomingWireBatches,
  checkingCreditLooksLikeFintualIncomingWire,
  checkingCreditLooksLikeMonthBucketCashReturn,
  checkingCreditMatchesLedgerNetWorthCapitalReturn,
  checkingCreditMatchesMonthBucketLedgerCapitalReturn,
  checkingCreditMatchesNetWorthCapitalReturn,
  checkingCreditMayAutoMatchNetWorthCapitalReturn,
  checkingFintualIncomingWireBatchMatchesLedgerNetWorthCapitalReturn,
  checkingWithdrawalFundsInvestmentCapital,
  isExcludedCheckingInflow,
  ledgerCapitalReturnMatchesTiming,
} from "./flowsCheckingGastos.js";
import { buildFlowsCheckingIncomePayload } from "./flowsCheckingInflows.js";
import {
  upsertCheckingIncomeMovementOverride,
  deleteCheckingIncomeMovementOverride,
} from "./flowsCheckingIncomeOverrides.js";

function insertCartolaLine(
  accountId: number,
  occurredOn: string,
  amountClp: number,
  description: string,
  idx: number
): number {
  const note =
    `import:cartola|${occurredOn.slice(0, 7)}|Agustinas|${description}|` +
    `on:${occurredOn}|amt:${amountClp}|idx:${idx}`;
  const ins = db
    .prepare(
      `INSERT INTO movements (account_id, amount_clp, occurred_on, note, units_delta)
       VALUES (?, ?, ?, ?, NULL)`
    )
    .run(accountId, amountClp, occurredOn, note);
  return Number(ins.lastInsertRowid);
}

describe("checkingCreditMatchesMonthBucketLedgerCapitalReturn", () => {
  it("pairs Depósito en Efectivo with month-end cuenta ahorro retiro in the same month", () => {
    expect(checkingCreditLooksLikeMonthBucketCashReturn("Depósito en Efectivo")).toBe(true);
    expect(
      ledgerCapitalReturnMatchesTiming(
        "2021-12-09",
        "2021-12-31",
        "cuenta_ahorro_vivienda",
        14
      )
    ).toBe(true);
    expect(
      ledgerCapitalReturnMatchesTiming(
        "2021-12-09",
        "2021-11-30",
        "cuenta_ahorro_vivienda",
        14
      )
    ).toBe(false);

    const credit = {
      occurred_on: "2021-12-09",
      amount_clp: 800_000,
      note:
        "import:cartola|2021-12|Villanelo|Depósito en Efectivo|on:2021-12-09|amt:800000|idx:5",
    };
    const ledgerRetiro = {
      occurred_on: "2021-12-31",
      amount_clp: 800_000,
      account_id: 80,
      category_slug: "cuenta_ahorro_vivienda",
      group_slug: "cash_eqs",
    };
    expect(
      checkingCreditMatchesMonthBucketLedgerCapitalReturn(credit, [ledgerRetiro])
    ).toBe(true);
    expect(
      checkingCreditMatchesNetWorthCapitalReturn(credit, [], {
        ledgerOutflows: [ledgerRetiro],
      })
    ).toBe(true);
  });

  it("also recognises Vales Vista / Cheque cash deposits as month-bucket cash returns", () => {
    expect(checkingCreditLooksLikeMonthBucketCashReturn("Depósito con Vales Vista")).toBe(true);
    expect(checkingCreditLooksLikeMonthBucketCashReturn("Depósito con Vale Vista")).toBe(true);
    expect(checkingCreditLooksLikeMonthBucketCashReturn("Depósito con Cheque")).toBe(true);
    // A plain transfer must not be mistaken for a cash-deposit return.
    expect(checkingCreditLooksLikeMonthBucketCashReturn("0768106274 Transf.")).toBe(false);

    const credit = {
      occurred_on: "2024-03-13",
      amount_clp: 10_100_000,
      note:
        "import:cartola|2024-03|CENTRO EXP|Depósito con Vales Vista|on:2024-03-13|amt:10100000|idx:13",
    };
    const ledgerRetiro = {
      occurred_on: "2024-03-31",
      amount_clp: 10_100_000,
      account_id: 80,
      category_slug: "cuenta_ahorro_vivienda",
      group_slug: "cash_eqs",
    };
    expect(checkingCreditMatchesMonthBucketLedgerCapitalReturn(credit, [ledgerRetiro])).toBe(true);
  });
});

describe("checkingCreditLooksLikeFintualIncomingWire", () => {
  it("matches truncated Fintual wires but not named person transfers", () => {
    expect(checkingCreditLooksLikeFintualIncomingWire("0768106274 Transf.")).toBe(true);
    expect(checkingCreditLooksLikeFintualIncomingWire("0768106274 Transf. Fintual AGF")).toBe(
      true
    );
    expect(
      checkingCreditLooksLikeFintualIncomingWire("0081172943 Transf. Cristian Alejandro Fraser")
    ).toBe(false);
  });
});

describe("checkingCreditMatchesLedgerNetWorthCapitalReturn", () => {
  it("pairs Fintual incoming wires with brokerage ledger retiros one-to-one", () => {
    const fintualCredit = {
      occurred_on: "2099-04-02",
      amount_clp: 3_500_000,
      note:
        "import:cartola|2099-04|401|0768106274 Transf.|on:2099-04-02|amt:3500000|idx:1",
    };
    const ledgerRetiro = {
      occurred_on: "2099-03-30",
      amount_clp: 3_500_000,
      account_id: 45,
      category_slug: "fintual_risky_norris",
      group_slug: "brokerage",
    };
    const consumed = new Set<string>();
    expect(
      checkingCreditMatchesLedgerNetWorthCapitalReturn(fintualCredit, [ledgerRetiro], {
        consumedLedgerOutflowKeys: consumed,
      })
    ).toBe(true);
    expect(consumed.size).toBe(1);

    const namedCredit = {
      occurred_on: "2099-04-02",
      amount_clp: 3_500_000,
      note:
        "import:cartola|2099-04|Agustinas|0081172943 Transf. Cristian Alejandro Fraser|on:2099-04-02|amt:3500000|idx:2",
    };
    expect(
      checkingCreditMatchesLedgerNetWorthCapitalReturn(namedCredit, [ledgerRetiro], {
        consumedLedgerOutflowKeys: new Set(),
      })
    ).toBe(false);
  });

  // A "Fintual AGF"-named incoming wire is BOTH dropped by isExcludedCheckingInflow AND a real
  // capital return. The income classifier must run the ledger match before the exclusion (see
  // classifyCheckingCreditForIncome) or these redemptions never link. Guard both halves so a future
  // exclusion/gate tweak can't silently re-orphan them.
  it("recognises an excluded Fintual-AGF wire as a capital return (ordering invariant)", () => {
    const description = "0768106274 Transf. Fintual AGF";
    expect(isExcludedCheckingInflow(description)).toBe(true);

    const fintualAgfCredit = {
      occurred_on: "2099-05-07",
      amount_clp: 5_500_000,
      note: `import:cartola|2099-05|Agustinas|${description}|on:2099-05-07|amt:5500000|idx:4`,
    };
    const reservaRetiro = {
      occurred_on: "2099-05-06",
      amount_clp: 5_500_000,
      account_id: 44,
      category_slug: "fondo_reserva",
      group_slug: "cash_eqs",
    };
    expect(
      checkingCreditMatchesLedgerNetWorthCapitalReturn(fintualAgfCredit, [reservaRetiro], {
        consumedLedgerOutflowKeys: new Set(),
      })
    ).toBe(true);
  });
});

describe("checkingFintualIncomingWireBatchMatchesLedgerNetWorthCapitalReturn", () => {
  it("sums same-day split Fintual wires against one ledger retiro", () => {
    const batch = buildFintualIncomingWireBatches([
      {
        movement_id: 1,
        account_id: 22,
        occurred_on: "2099-05-11",
        amount_clp: 6_000_000,
        note:
          "import:cartola|2099-05|Agustinas|0768106274 Transf.|doc:9250424|on:2099-05-11|amt:6000000|idx:1",
      },
      {
        movement_id: 2,
        account_id: 22,
        occurred_on: "2099-05-11",
        amount_clp: 7_000_000,
        note:
          "import:cartola|2099-05|Agustinas|0768106274 Transf.|doc:9250424|on:2099-05-11|amt:7000000|idx:2",
      },
    ]).batches[0]!;
    expect(batch.total_clp).toBe(13_000_000);

    const ledgerRetiro = {
      occurred_on: "2099-05-10",
      amount_clp: 13_000_000,
      account_id: 44,
      category_slug: "fintual_risky_norris",
      group_slug: "brokerage",
    };
    const consumed = new Set<string>();
    expect(
      checkingFintualIncomingWireBatchMatchesLedgerNetWorthCapitalReturn(batch, [ledgerRetiro], {
        consumedLedgerOutflowKeys: consumed,
      })
    ).toBe(true);
    expect(consumed.size).toBe(1);
  });
});

describe("checkingCreditMayAutoMatchNetWorthCapitalReturn", () => {
  it("allows generic electronic abonos but not named person transfers", () => {
    expect(checkingCreditMayAutoMatchNetWorthCapitalReturn("ABONO TRANSFERENCIA ELECTRONICA")).toBe(
      true
    );
    expect(
      checkingCreditMayAutoMatchNetWorthCapitalReturn(
        "0081172943 Transf. Cristian Alejandro Fraser"
      )
    ).toBe(false);
  });
});

describe("checkingCreditMatchesNetWorthCapitalReturn", () => {
  it("requires a same-amount Fintual/reserva checking outflow, not ledger-only amount match", () => {
    const genericCredit = {
      occurred_on: "2099-02-10",
      amount_clp: 3_500_000,
      note:
        "import:cartola|2099-02|Agustinas|ABONO TRANSFERENCIA ELECTRONICA|on:2099-02-10|amt:3500000|idx:1",
    };
    const unrelatedWithdrawal = {
      account_id: 1,
      occurred_on: "2099-02-05",
      amount_clp: -3_500_000,
      note: "import:cartola|2099-02|Agustinas|REMUNERACION EMPRESA|on:2099-02-05|amt:-3500000|idx:1",
    };
    expect(
      checkingCreditMatchesNetWorthCapitalReturn(genericCredit, [unrelatedWithdrawal])
    ).toBe(false);

    const fintualWithdrawal = {
      account_id: 1,
      occurred_on: "2099-02-07",
      amount_clp: -3_500_000,
      note:
        "import:cartola|2099-02|Agustinas|0768106274 Transf a FINTUAL ADMINISTRADORA G|on:2099-02-07|amt:-3500000|idx:2",
    };
    expect(checkingWithdrawalFundsInvestmentCapital(fintualWithdrawal.note)).toBe(true);
    expect(
      checkingCreditMatchesNetWorthCapitalReturn(genericCredit, [fintualWithdrawal])
    ).toBe(true);

    const namedCredit = {
      occurred_on: "2099-02-10",
      amount_clp: 3_500_000,
      note:
        "import:cartola|2099-02|Agustinas|0081172943 Transf. Cristian Alejandro Fraser|on:2099-02-10|amt:3500000|idx:3",
    };
    expect(checkingCreditMatchesNetWorthCapitalReturn(namedCredit, [fintualWithdrawal])).toBe(
      false
    );
  });

  it("uses ledger retiros for Fintual incoming wires without a checking outflow", () => {
    const fintualCredit = {
      occurred_on: "2099-04-02",
      amount_clp: 3_500_000,
      note:
        "import:cartola|2099-04|401|0768106274 Transf.|on:2099-04-02|amt:3500000|idx:4",
    };
    const ledgerRetiro = {
      occurred_on: "2099-03-30",
      amount_clp: 3_500_000,
      account_id: 45,
      category_slug: "fintual_risky_norris",
      group_slug: "brokerage",
    };
    expect(
      checkingCreditMatchesNetWorthCapitalReturn(fintualCredit, [], {
        ledgerOutflows: [ledgerRetiro],
      })
    ).toBe(true);
  });
});

describe("income force_include", () => {
  it("includes a cartola credit filtered by description when force_include is set", () => {
    const accountId = checkingAccountId();
    const movementId = insertCartolaLine(
      accountId,
      "2099-03-11",
      120_000,
      "Traspaso Internet de Cuenta Vista",
      991301
    );
    try {
      const before = buildFlowsCheckingIncomePayload();
      expect(before.lines.some((l) => l.movement_id === movementId)).toBe(false);
      expect(before.filtered_lines.some((l) => l.movement_id === movementId)).toBe(true);

      upsertCheckingIncomeMovementOverride(movementId, { force_include: true });
      const after = buildFlowsCheckingIncomePayload();
      expect(after.lines.some((l) => l.movement_id === movementId)).toBe(true);
      expect(after.filtered_lines.some((l) => l.movement_id === movementId)).toBe(false);
    } finally {
      deleteCheckingIncomeMovementOverride(movementId);
      db.prepare(`DELETE FROM movements WHERE id = ?`).run(movementId);
    }
  });
});

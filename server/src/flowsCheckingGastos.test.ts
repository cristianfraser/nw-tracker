import { FLOW_CATEGORY_ROWS_SQL } from "./test/flowFixtures.js";
import { assignFlowExpenseLineCategory } from "./expenseAssignmentWrites.js";
import { describe, expect, it } from "vitest";
import { checkingCartolaStablePurchaseKey } from "./checkingCartolaParse.js";
import { db } from "./db.js";
import {
  autoMatchCategorySlugForDeposit,
  checkingGastosMovementBelongs,
  checkingGastosMovementPurchaseKey,
  buildCheckingGastosLines,
  computeMercadoCapitalesInternalTransferMonths,
  createSplittableInternalTransferPool,
  depositMatchesInternalTransferTiming,
  ledgerCapitalReturnMatchesTiming,
  splitCheckingWithdrawalAgainstDeposits,
  matchWithdrawalToDeposit,
  matchWithdrawalToInvestmentDeposit,
  withdrawalIsReversedByDapAbono,
  withdrawalMatchesInternalCashTransfer,
} from "./flowsCheckingGastos.js";
import {
  loadCheckingCredits,
  type CheckingCredit,
  type DepositMatchCandidate,
} from "./checkingCartolaLoaders.js";
import {
  cartolaDescriptionFromNote,
  cartolaDocumentFromNote,
  checkingOutflowIsAtmWithdrawal,
  checkingWithdrawalMayAutoMatchDeposit,
  isCheckingCorrienteVistaTraspasoOutflow,
  isDapAbonoDescription,
  isExcludedCheckingWithdrawal,
  isInvestmentDepositTarget,
  isMercadoCapitalesCargoDescription,
  stripCheckingBranchPrefix,
  isCheckingOwnTraspasoInflow,
  isCheckingOwnTraspasoOutflow,
} from "./checkingDescriptionPredicates.js";
import { buildFlowsExpensesPayload } from "./flowsExpenses.js";
import { isAutoDepositMatchedPurchaseNote } from "./ccExpenseDepositMatchNotes.js";
import { enrichFlowLinesWithPurchaseNotes } from "./ccExpensePurchaseNotes.js";
import { cartolaCashAccountIdOptional } from "./movementBalanceCashAccounts.js";
import { checkingAccountId } from "./checkingCartolaImport.js";
import { checkingLedgerAnchorNote } from "./checkingCartolaBalances.js";

function insertCheckingCartolaWithdrawal(
  accountId: number,
  occurredOn: string,
  amountClp: number,
  description: string,
  opts: { cartolaMonth: string; branch?: string; doc?: string; idx: number }
): number {
  const branch = opts.branch ?? "Agustinas";
  const docPart = opts.doc ? `|doc:${opts.doc}` : "";
  const note =
    `import:cartola|${opts.cartolaMonth}|${branch}|${description}` +
    `${docPart}|on:${occurredOn}|amt:${amountClp}|idx:${opts.idx}`;
  const ins = db
    .prepare(
      `INSERT INTO movements (account_id, amount, currency, occurred_on, note, units_delta)
       VALUES (?, ?, 'clp', ?, ?, NULL)`
    )
    .run(accountId, amountClp, occurredOn, note);
  return Number(ins.lastInsertRowid);
}

/** The Vitest person's cuenta vista (`demoData/generate.ts`). */
function requireVistaId(): number {
  const id = cartolaCashAccountIdOptional("cuenta_vista");
  expect(id).not.toBeNull();
  return id!;
}

function deleteCheckingMovements(ids: readonly number[]): void {
  if (ids.length === 0) return;
  const placeholders = ids.map(() => "?").join(", ");
  db.prepare(`DELETE FROM movements WHERE id IN (${placeholders})`).run(...ids);
}

describe("flowsCheckingGastos", () => {
  it("builds checking-internal lines for exactly paired corriente/vista transfers", () => {
    const corrienteId = checkingAccountId();
    const vistaId = requireVistaId();

    const movementId = insertCheckingCartolaWithdrawal(
      corrienteId,
      "2099-07-01",
      -500_000,
      "Transf. Internet a otro Bancos",
      { cartolaMonth: "2099-07", idx: 9998801 }
    );
    for (const portion of ["gastos", "deposit"] as const) {
      const key = checkingGastosMovementPurchaseKey(movementId, portion);
      db.prepare(
        `DELETE FROM flow_categories WHERE rowid IN (SELECT rid FROM ${FLOW_CATEGORY_ROWS_SQL} WHERE account_id = ? AND purchase_key = ?)`
      ).run(corrienteId, key);
    }

    const depositCandidates: DepositMatchCandidate[] = [
      {
        occurred_on: "2099-07-01",
        amount_clp: 500_000,
        account_id: vistaId,
        category_slug: "cuenta_vista",
        group_slug: "cash_eqs",
        claim_key: "flowsCheckingGastos-102",
        movement_id: null,
      },
    ];

    const lines = buildCheckingGastosLines({
      accountId: corrienteId,
      depositCandidates,
      checkingCredits: [],
    });

    const internalLines = lines.filter(
      (l) =>
        l.category_slug === "checking_internal_transfer" && l.statement_line_id === movementId
    );
    expect(internalLines).toHaveLength(1);
    expect(internalLines[0]?.amount_clp).toBe(500_000);
    expect(internalLines[0]?.checking_purchase_portion).toBe("deposit");
    expect(internalLines[0]?.category_unique).toBe(true);

    deleteCheckingMovements([movementId]);
    for (const portion of ["gastos", "deposit"] as const) {
      const key = checkingGastosMovementPurchaseKey(movementId, portion);
      db.prepare(
        `DELETE FROM flow_categories WHERE rowid IN (SELECT rid FROM ${FLOW_CATEGORY_ROWS_SQL} WHERE account_id = ? AND purchase_key = ?)`
      ).run(corrienteId, key);
    }
  });

  it("builds gastos lines per checking account including cuenta vista when present", () => {
    const vistaId = requireVistaId();
    const movId = insertCheckingCartolaWithdrawal(vistaId, "2099-07-08", -4_321, "Compra ACME STORE", {
      cartolaMonth: "2099-07",
      idx: 9998831,
    });
    try {
      const vistaLines = buildCheckingGastosLines({ accountId: vistaId });
      for (const line of vistaLines) {
        expect(line.account_id).toBe(vistaId);
        expect(line.source).toBe("checking");
      }
      const hit = vistaLines.filter((l) => l.statement_line_id === movId);
      expect(hit).toHaveLength(1);
      expect(hit[0]!.amount_clp).toBe(4_321);
      expect(hit[0]!.expense_month).toBe("2099-07");
      expect(hit[0]!.checking_purchase_portion).toBeUndefined();
    } finally {
      deleteCheckingMovements([movId]);
    }
  });

  it("parses cartola description from movement note", () => {
    const note =
      "import:cartola|2024-03|Las Condes|TRASPASO A FINTUAL|doc:123";
    expect(cartolaDescriptionFromNote(note)).toBe("TRASPASO A FINTUAL");
    expect(cartolaDocumentFromNote(note)).toBe("123");
    const withMeta =
      "import:cartola|2023-02|Agustinas|Transf. Internet a otro Bancos|on:2023-02-03|amt:-555000|idx:1";
    expect(cartolaDescriptionFromNote(withMeta)).toBe("Transf. Internet a otro Bancos");
    expect(cartolaDocumentFromNote(withMeta)).toBeNull();
  });

  it("detects mercado capitales cargo and DAP abono descriptions", () => {
    expect(isMercadoCapitalesCargoDescription("Cargo Mercado Capitales")).toBe(true);
    expect(isMercadoCapitalesCargoDescription("00350323026433811444")).toBe(true);
    expect(isMercadoCapitalesCargoDescription("TRASPASO A FINTUAL")).toBe(false);
    expect(isDapAbonoDescription("DAP 026434101963 ABONADO")).toBe(true);
    expect(isDapAbonoDescription("Depósito con Vales Vista")).toBe(false);
  });

  it("treats DAP-reversed MC cargos as non-gastos (March 2024 doc pairing)", () => {
    const credits: CheckingCredit[] = [
      {
        occurred_on: "2024-03-11",
        amount_clp: 30_621_285,
        note: "import:cartola|2024-03|PENALOLEN|DAP 026433811444 ABONADO|doc:3811444",
      },
      {
        occurred_on: "2024-03-18",
        amount_clp: 43_728_153,
        note: "import:cartola|2024-03|PENALOLEN|DAP 026434101963 ABONADO|doc:4101963",
      },
      {
        occurred_on: "2024-03-25",
        amount_clp: 53_880_515,
        note: "import:cartola|2024-03|PENALOLEN|DAP 026434299119 ABONADO|doc:4299119",
      },
      {
        occurred_on: "2024-04-02",
        amount_clp: 57_960_336,
        note: "import:cartola|2024-04|PENALOLEN|DAP 026434575337 ABONADO|doc:4575337",
      },
    ];
    expect(
      withdrawalIsReversedByDapAbono(
        {
          occurred_on: "2024-03-04",
          amount_clp: -30_589_409,
          note: "import:cartola|2024-03|O.Gerencia|00350323026433811444|doc:3811444",
        },
        credits
      )
    ).toBe(true);
    expect(
      withdrawalIsReversedByDapAbono(
        {
          occurred_on: "2024-03-11",
          amount_clp: -43_682_633,
          note: "import:cartola|2024-03|O.Gerencia|Cargo Mercado Capitales|doc:4101963",
        },
        credits
      )
    ).toBe(true);
    expect(
      withdrawalIsReversedByDapAbono(
        {
          occurred_on: "2024-03-18",
          amount_clp: -53_823_153,
          note: "import:cartola|2024-03|O.Gerencia|Cargo Mercado Capitales|doc:4299119",
        },
        credits
      )
    ).toBe(true);
    expect(
      withdrawalIsReversedByDapAbono(
        {
          occurred_on: "2024-03-26",
          amount_clp: -57_900_000,
          note: "import:cartola|2024-03|O.Gerencia|Cargo Mercado Capitales|doc:4575337",
        },
        credits
      )
    ).toBe(true);
  });

  it("treats long-window DAP maturity as non-gasto (Aug 2024 doc 8818234)", () => {
    const credits: CheckingCredit[] = [
      {
        occurred_on: "2024-09-09",
        amount_clp: 903_255,
        note: "import:cartola|2024-09|PENALOLEN|DAP 026438818234 ABONADO|doc:8818234",
      },
    ];
    expect(
      withdrawalIsReversedByDapAbono(
        {
          occurred_on: "2024-08-09",
          amount_clp: -900_000,
          note: "import:cartola|2024-08|O.Gerencia|00350323026438818234|doc:8818234",
        },
        credits
      )
    ).toBe(true);
  });

  it("treats Aug 2024 DAP maturity with ~0.49% interest as non-gasto (doc 9204418)", () => {
    expect(
      withdrawalIsReversedByDapAbono(
        {
          occurred_on: "2024-08-23",
          amount_clp: -4_140_553,
          note: "import:cartola|2024-08|O.Gerencia|Cargo Mercado Capitales|doc:9204418",
        },
        [
          {
            occurred_on: "2024-10-04",
            amount_clp: 4_160_842,
            note: "import:cartola|2024-10|PENALOLEN|DAP 026439204418 ABONADO|doc:9204418",
          },
        ]
      )
    ).toBe(true);
  });

  it("does not reverse MC cargo when DAP ABONADO fails pairing checks", () => {
    const cargo = {
      occurred_on: "2024-08-23",
      amount_clp: -4_140_553,
      note: "import:cartola|2024-08|O.Gerencia|Cargo Mercado Capitales|doc:9204418",
    };
    expect(
      withdrawalIsReversedByDapAbono(cargo, [
        {
          occurred_on: "2024-08-20",
          amount_clp: 4_200_000,
          note: "import:cartola|2024-08|PENALOLEN|DAP 026439204418 ABONADO|doc:9204418",
        },
      ])
    ).toBe(false);
    expect(
      withdrawalIsReversedByDapAbono(cargo, [
        {
          occurred_on: "2024-09-23",
          amount_clp: 4_300_000,
          note: "import:cartola|2024-09|PENALOLEN|DAP 026439204418 ABONADO|doc:9204418",
        },
      ])
    ).toBe(false);
    expect(
      withdrawalIsReversedByDapAbono(cargo, [
        {
          occurred_on: "2025-08-23",
          amount_clp: 4_600_000,
          note: "import:cartola|2025-08|PENALOLEN|DAP 026439204418 ABONADO|doc:9204418",
        },
      ])
    ).toBe(false);
    expect(
      withdrawalIsReversedByDapAbono(cargo, [
        {
          occurred_on: "2024-09-23",
          amount_clp: 4_200_000,
          note: "import:cartola|2024-09|PENALOLEN|DAP 026439999999 ABONADO|doc:9999999",
        },
      ])
    ).toBe(false);
  });

  it("allows higher premium tolerance", () => {
    const cargo = {
      occurred_on: "2024-01-01",
      amount_clp: -1_000_000,
      note: "import:cartola|2024-01|O.Gerencia|Cargo Mercado Capitales|doc:5000",
    };
    expect(
      withdrawalIsReversedByDapAbono(cargo, [
        {
          occurred_on: "2024-01-08",
          amount_clp: 1_010_000,
          note: "import:cartola|2024-01|PENALOLEN|DAP 02645000 ABONADO|doc:5000",
        },
      ])
    ).toBe(true);
    expect(
      withdrawalIsReversedByDapAbono(cargo, [
        {
          occurred_on: "2024-12-30",
          amount_clp: 1_099_000,
          note: "import:cartola|2024-12|PENALOLEN|DAP 02645000 ABONADO|doc:5000",
        },
      ])
    ).toBe(true);
    expect(
      withdrawalIsReversedByDapAbono(cargo, [
        {
          occurred_on: "2024-12-30",
          amount_clp: 1_120_000,
          note: "import:cartola|2024-12|PENALOLEN|DAP 02645000 ABONADO|doc:5000",
        },
      ])
    ).toBe(false);
  });

  it("matches DAP ABONADO on cargo doc +1 or +2", () => {
    const cargo = {
      occurred_on: "2024-01-10",
      amount_clp: -1_000_000,
      note: "import:cartola|2024-01|O.Gerencia|Cargo Mercado Capitales|doc:1000",
    };
    expect(
      withdrawalIsReversedByDapAbono(cargo, [
        {
          occurred_on: "2024-01-17",
          amount_clp: 1_001_000,
          note: "import:cartola|2024-01|PENALOLEN|DAP 02641001001 ABONADO|doc:1001",
        },
      ])
    ).toBe(true);
    expect(
      withdrawalIsReversedByDapAbono(cargo, [
        {
          occurred_on: "2024-01-17",
          amount_clp: 1_001_000,
          note: "import:cartola|2024-01|PENALOLEN|DAP 02641001002 ABONADO|doc:1002",
        },
      ])
    ).toBe(true);
  });

  it("treats cuenta vista COBRO VVISTA DAP return as non-gasto for MC cargo (Aug 2024 doc 9204418)", () => {
    expect(
      withdrawalIsReversedByDapAbono(
        {
          occurred_on: "2024-08-23",
          amount_clp: -4_140_553,
          note: "import:cartola|2024-08|O.Gerencia|Cargo Mercado Capitales|doc:9204418",
        },
        [
          {
            occurred_on: "2024-10-04",
            amount_clp: 4_160_842,
            note: "import:cartola|2024-10|PENALOLEN|COBRO VVISTA 026439204418-0000|doc:9204418",
          },
        ]
      )
    ).toBe(true);
  });

  it("excludes DAP-reversed MC cargos from checking gastos lines", () => {
    const corrienteId = checkingAccountId();
    const checkingCredits: CheckingCredit[] = [
      {
        occurred_on: "2099-03-11",
        amount_clp: 30_621_285,
        note: "import:cartola|2099-03|PENALOLEN|DAP 026433811444 ABONADO|doc:3811444",
      },
      {
        occurred_on: "2099-09-09",
        amount_clp: 903_255,
        note: "import:cartola|2099-09|PENALOLEN|DAP 026438818234 ABONADO|doc:8818234",
      },
    ];

    const movementIds = [
      insertCheckingCartolaWithdrawal(
        corrienteId,
        "2099-03-04",
        -30_589_409,
        "00350323026433811444",
        { cartolaMonth: "2099-03", branch: "O.Gerencia", doc: "3811444", idx: 8802 }
      ),
      insertCheckingCartolaWithdrawal(
        corrienteId,
        "2099-08-09",
        -900_000,
        "00350323026438818234",
        { cartolaMonth: "2099-08", branch: "O.Gerencia", doc: "8818234", idx: 8803 }
      ),
      insertCheckingCartolaWithdrawal(
        corrienteId,
        "2099-11-18",
        -19_799_625,
        "Cargo Mercado Capitales",
        { cartolaMonth: "2099-11", branch: "Providenci", doc: "6665868", idx: 8804 }
      ),
    ];

    const lines = buildCheckingGastosLines({
      accountId: corrienteId,
      depositCandidates: [],
      checkingCredits,
    });

    const mcMerchants = (month: string) =>
      lines
        .filter(
          (l) =>
            l.expense_month === month &&
            l.source === "checking" &&
            (l.merchant?.includes("Mercado Capitales") ||
              /^\d{10,}$/.test((l.merchant ?? "").replace(/\s/g, "")))
        )
        .map((l) => ({ id: l.statement_line_id, amount: l.amount_clp, merchant: l.merchant }));

    expect(mcMerchants("2099-03")).toEqual([]);
    expect(mcMerchants("2099-08")).toEqual([]);
    expect(mcMerchants("2099-11")).toEqual([
      expect.objectContaining({
        id: movementIds[2],
        amount: 19_799_625,
        merchant: "Cargo Mercado Capitales",
      }),
    ]);

    deleteCheckingMovements(movementIds);
  });

  it("excludes Mercado Capitales month when cargos sum to cash/efectivo inflows (Jan 2024)", () => {
    const withdrawals = [
      {
        occurred_on: "2024-01-02",
        amount_clp: -7_500_000,
        note: "import:cartola|2024-01|O.Gerencia|Cargo Mercado Capitales|doc:1783095",
      },
      {
        occurred_on: "2024-01-09",
        amount_clp: -13_000_000,
        note: "import:cartola|2024-01|O.Gerencia|Cargo Mercado Capitales|doc:2070963",
      },
      {
        occurred_on: "2024-01-25",
        amount_clp: -6_514_000,
        note: "import:cartola|2024-01|O.Gerencia|Cargo Mercado Capitales|doc:2588709",
      },
      {
        occurred_on: "2024-01-31",
        amount_clp: -3_000_000,
        note: "import:cartola|2024-01|O.Gerencia|Cargo Mercado Capitales|doc:2786306",
      },
    ];
    const deposits: DepositMatchCandidate[] = [
      {
        occurred_on: "2024-01-31",
        amount_clp: 30_014_000,
        account_id: 1,
        category_slug: "cuenta_ahorro_vivienda",
        group_slug: "cash_eqs",
        claim_key: "flowsCheckingGastos-494",
        movement_id: null,
      },
    ];
    const months = computeMercadoCapitalesInternalTransferMonths(0, deposits, {
      checkingWithdrawals: withdrawals,
      checkingCredits: [],
    });
    expect(months.has("2024-01")).toBe(true);
  });

  it("excludes Fintual administrator wires from gastos", () => {
    expect(
      isExcludedCheckingWithdrawal("0768106274 Transf a FINTUAL ADMINISTRADORA G")
    ).toBe(true);
  });

  it("excludes internal transfer and cc payment descriptions", () => {
    expect(isExcludedCheckingWithdrawal("Titular Demo - Santander")).toBe(true);
    expect(isExcludedCheckingWithdrawal("MONTO CANCELADO")).toBe(true);
    expect(isExcludedCheckingWithdrawal("PAGO TARJETA DE CREDITO")).toBe(true);
    expect(isExcludedCheckingWithdrawal("Traspaso Internet a T. Crédito")).toBe(true);
    expect(isExcludedCheckingWithdrawal("Traspaso Internet a Cuentamática")).toBe(true);
    expect(isExcludedCheckingWithdrawal("Traspaso a Cuenta Vista 10% AFP")).toBe(true);
    expect(isExcludedCheckingWithdrawal("Traspaso a Cuenta Vista 10%")).toBe(true);
    expect(isExcludedCheckingWithdrawal("Egreso por Compra de Divisas")).toBe(true);
    expect(isExcludedCheckingWithdrawal("Traspaso Internet a Línea Crédito")).toBe(true);
    expect(isExcludedCheckingWithdrawal("Traspaso Internet a Cta. Cte.")).toBe(false);
    expect(isExcludedCheckingWithdrawal("Traspaso Internet desde Cta.Ct")).toBe(false);
    expect(isCheckingCorrienteVistaTraspasoOutflow("Traspaso Internet a Cta. Cte.")).toBe(true);
    expect(isCheckingCorrienteVistaTraspasoOutflow("Traspaso Internet desde Cta.Ct")).toBe(
      false
    );
    expect(isExcludedCheckingWithdrawal("TRASPASO A FINTUAL")).toBe(false);
    expect(isExcludedCheckingWithdrawal("TRASPASO A FONDO RESERVA")).toBe(true);
    expect(isExcludedCheckingWithdrawal("DEPOSITO A RESERVA FINTUAL")).toBe(true);
    // CMR is a card (·0876): paying it is a card payment like any other.
    expect(isExcludedCheckingWithdrawal("PAGO EN LINEA PROM. CMR FALABE")).toBe(true);
    expect(isExcludedCheckingWithdrawal("PAGO EN LINEA CMR FALABELLA")).toBe(true);
  });

  it("treats checking outflows paired with cash/efectivo deposits as internal", () => {
    const reservaId = 990_021;
    const deposits: DepositMatchCandidate[] = [
      {
        occurred_on: "2024-03-15",
        amount_clp: 500_000,
        account_id: reservaId,
        category_slug: "fondo_reserva",
        group_slug: "cash_eqs",
        claim_key: "flowsCheckingGastos-541",
        movement_id: null,
      },
      {
        occurred_on: "2024-03-15",
        amount_clp: 500_000,
        account_id: 999_999,
        category_slug: "spy",
        group_slug: "brokerage",
        claim_key: "flowsCheckingGastos-548",
        movement_id: null,
      },
    ];
    expect(
      withdrawalMatchesInternalCashTransfer(
        { occurred_on: "2024-03-16", amount_clp: -500_000 },
        deposits
      )
    ).toBe(true);
    expect(
      withdrawalMatchesInternalCashTransfer(
        { occurred_on: "2024-03-16", amount_clp: -500_000 },
        deposits
      )
    ).toBe(true);
  });

  it("treats checking outflows paired with cuenta ahorro vivienda deposit in same month as internal", () => {
    const deposits: DepositMatchCandidate[] = [
      {
        occurred_on: "2021-03-31",
        amount_clp: 1_500_000,
        account_id: 23,
        category_slug: "cuenta_ahorro_vivienda",
        group_slug: "cash_eqs",
        claim_key: "flowsCheckingGastos-572",
        movement_id: null,
      },
    ];
    expect(
      withdrawalMatchesInternalCashTransfer(
        { occurred_on: "2021-03-01", amount_clp: -1_500_000 },
        deposits
      )
    ).toBe(true);
    expect(
      withdrawalMatchesInternalCashTransfer(
        { occurred_on: "2021-04-01", amount_clp: -1_500_000 },
        deposits
      )
    ).toBe(false);
    expect(
      depositMatchesInternalTransferTiming(
        { occurred_on: "2021-03-01" },
        { occurred_on: "2021-03-31", category_slug: "cuenta_ahorro_vivienda" }
      )
    ).toBe(true);
    expect(
      depositMatchesInternalTransferTiming(
        { occurred_on: "2021-03-01" },
        { occurred_on: "2021-03-05", category_slug: "fondo_reserva" },
        3
      )
    ).toBe(false);
  });

  it("detects ATM withdrawals including branch-prefixed descriptions", () => {
    expect(checkingOutflowIsAtmWithdrawal("Giro en Cajero Automático")).toBe(true);
    expect(checkingOutflowIsAtmWithdrawal("Agustinas Giro en Cajero Automático")).toBe(true);
    expect(stripCheckingBranchPrefix("Agustinas Transf. Internet a otro Bancos")).toBe(
      "Transf. Internet a otro Bancos"
    );
    expect(checkingOutflowIsAtmWithdrawal("Transf. Internet a otro Bancos")).toBe(false);
  });

  it("does not pair ATM giros with coincident deposit inflows", () => {
    const deposits: DepositMatchCandidate[] = [
      {
        occurred_on: "2017-11-21",
        amount_clp: 30_000,
        account_id: 41,
        category_slug: "cuenta_vista",
        group_slug: "cash_eqs",
        claim_key: "flowsCheckingGastos-628",
        movement_id: null,
      },
    ];
    const split = splitCheckingWithdrawalAgainstDeposits(
      {
        occurred_on: "2017-11-21",
        amount_clp: -30_000,
        description: "Agustinas Giro en Cajero Automático",
      },
      deposits,
      {
        splittablePool: createSplittableInternalTransferPool(deposits),
        usedDepositKeys: new Set(),
        withdrawalAccountId: 41,
        withdrawalCategorySlug: "cuenta_vista",
      }
    );
    expect(split.internalClp).toBe(0);
    expect(split.gastosClp).toBe(30_000);
    expect(split.investmentDeposit).toBeNull();
    expect(withdrawalMatchesInternalCashTransfer(
      {
        occurred_on: "2017-11-21",
        amount_clp: -30_000,
        description: "Giro en Cajero Automático",
      },
      deposits,
      3,
      createSplittableInternalTransferPool(deposits)
    )).toBe(false);
  });

  it("does not net same-day cuenta vista deposits against vista withdrawals (Aug 2019)", () => {
    const vistaId = 99;
    const deposits: DepositMatchCandidate[] = [
      {
        occurred_on: "2019-08-01",
        amount_clp: 23_370,
        account_id: vistaId,
        category_slug: "cuenta_vista",
        group_slug: "cash_eqs",
        claim_key: "flowsCheckingGastos-668",
        movement_id: null,
      },
      {
        occurred_on: "2019-08-01",
        amount_clp: 2_124_100,
        account_id: vistaId,
        category_slug: "cuenta_vista",
        group_slug: "cash_eqs",
        claim_key: "flowsCheckingGastos-675",
        movement_id: null,
      },
    ];
    const split = splitCheckingWithdrawalAgainstDeposits(
      {
        occurred_on: "2019-08-01",
        amount_clp: -800_000,
        description: "Transf. Internet a otro Bancos",
      },
      deposits,
      {
        splittablePool: createSplittableInternalTransferPool(deposits),
        usedDepositKeys: new Set(),
        withdrawalAccountId: vistaId,
        withdrawalCategorySlug: "cuenta_vista",
      }
    );
    expect(split.internalClp).toBe(0);
    expect(split.gastosClp).toBe(800_000);
    expect(split.investmentDeposit).toBeNull();
  });

  it("pairs two same-amount reserva deposits 1:1 with two same-amount outflows (same-date first)", () => {
    // Reserva2 (fondo_reserva, cash bucket): two 3M deposits on different days plus two 3M
    // checking wires. Sharing one usedDepositKeys set across the loop must give a 1:1 pairing —
    // not both outflows claiming the earlier deposit (which orphaned mov 10721).
    const reservaId = 44;
    const checkingId = 10;
    const deposits: DepositMatchCandidate[] = [
      {
        occurred_on: "2024-11-19",
        amount_clp: 3_000_000,
        account_id: reservaId,
        category_slug: "fondo_reserva",
        group_slug: "cash_eqs",
        claim_key: "flowsCheckingGastos-709",
        movement_id: null,
      },
      {
        occurred_on: "2024-11-22",
        amount_clp: 3_000_000,
        account_id: reservaId,
        category_slug: "fondo_reserva",
        group_slug: "cash_eqs",
        claim_key: "flowsCheckingGastos-716",
        movement_id: null,
      },
    ];
    const opts = {
      splittablePool: createSplittableInternalTransferPool(deposits),
      usedDepositKeys: new Set<string>(),
      withdrawalAccountId: checkingId,
      withdrawalCategorySlug: "cuenta_corriente",
    };

    // Process the later outflow first: same-date preference should still pick the 11-22 deposit.
    const splitNov22 = splitCheckingWithdrawalAgainstDeposits(
      {
        occurred_on: "2024-11-22",
        amount_clp: -3_000_000,
        description: "Transf. Internet a otro Bancos",
      },
      deposits,
      opts
    );
    expect(splitNov22.internalClp).toBe(3_000_000);
    expect(splitNov22.internalMatchedDeposits).toHaveLength(1);
    expect(splitNov22.internalMatchedDeposits[0].deposit.occurred_on).toBe("2024-11-22");

    const splitNov19 = splitCheckingWithdrawalAgainstDeposits(
      {
        occurred_on: "2024-11-19",
        amount_clp: -3_000_000,
        description: "Transf. Internet a otro Bancos",
      },
      deposits,
      opts
    );
    expect(splitNov19.internalClp).toBe(3_000_000);
    expect(splitNov19.internalMatchedDeposits).toHaveLength(1);
    expect(splitNov19.internalMatchedDeposits[0].deposit.occurred_on).toBe("2024-11-19");
  });

  it("shows both Jul 2019 cuenta vista $700k outflows when not exactly paired (Jul 2019)", () => {
    const vistaId = 99;
    const corrienteId = 10;
    const splitOpts = {
      splittablePool: createSplittableInternalTransferPool([]),
      usedDepositKeys: new Set<string>(),
      withdrawalAccountId: vistaId,
      withdrawalCategorySlug: "cuenta_vista",
    };

    const splitJul1 = splitCheckingWithdrawalAgainstDeposits(
      {
        occurred_on: "2019-07-01",
        amount_clp: -700_000,
        description: "Transf. Internet a otro Bancos",
      },
      [],
      splitOpts
    );
    expect(splitJul1.internalClp).toBe(0);
    expect(splitJul1.gastosClp).toBe(700_000);

    const splitJul2 = splitCheckingWithdrawalAgainstDeposits(
      {
        occurred_on: "2019-07-02",
        amount_clp: -700_000,
        description: "Traspaso Internet a Cta. Cte.",
      },
      [],
      {
        ...splitOpts,
        usedDepositKeys: new Set(),
      }
    );
    expect(splitJul2.internalClp).toBe(0);
    expect(splitJul2.gastosClp).toBe(700_000);

    const deposits: DepositMatchCandidate[] = [
      {
        occurred_on: "2019-07-02",
        amount_clp: 700_000,
        account_id: corrienteId,
        category_slug: "cuenta_corriente",
        group_slug: "cash_eqs",
        claim_key: "flowsCheckingGastos-797",
        movement_id: null,
      },
    ];
    const splitJul2Paired = splitCheckingWithdrawalAgainstDeposits(
      {
        occurred_on: "2019-07-02",
        amount_clp: -700_000,
        description: "Traspaso Internet a Cta. Cte.",
      },
      deposits,
      {
        splittablePool: createSplittableInternalTransferPool(deposits),
        usedDepositKeys: new Set(),
        withdrawalAccountId: vistaId,
        withdrawalCategorySlug: "cuenta_vista",
      }
    );
    expect(splitJul2Paired.internalClp).toBe(700_000);
    expect(splitJul2Paired.gastosClp).toBe(0);

    const vistaIdReal = requireVistaId();
    const movId = insertCheckingCartolaWithdrawal(
      vistaIdReal,
      "2099-07-02",
      -700_000,
      "Traspaso Internet a Cta. Cte.",
      { cartolaMonth: "2099-07", idx: 8805 }
    );
    try {
      const lines = buildCheckingGastosLines({
        accountId: vistaIdReal,
        depositCandidates: [],
        checkingCredits: [],
      });
      const hit = lines.find((l) => l.statement_line_id === movId);
      expect(hit?.category_slug).toBe("checking_internal_transfer");
      expect(hit?.checking_purchase_portion).toBe("deposit");
      expect(hit?.category_unique).toBe(true);
      expect(hit?.amount_clp).toBe(700_000);
    } finally {
      deleteCheckingMovements([movId]);
    }
  });

  it("does not partial-match cross-account vista inflows against corriente wires (Nov 2017)", () => {
    const corrienteId = 10;
    const deposits: DepositMatchCandidate[] = [
      {
        occurred_on: "2017-11-27",
        amount_clp: 30_000,
        account_id: 99,
        category_slug: "cuenta_vista",
        group_slug: "cash_eqs",
        claim_key: "flowsCheckingGastos-848",
        movement_id: null,
      },
      {
        occurred_on: "2017-11-30",
        amount_clp: 37_914,
        account_id: 99,
        category_slug: "cuenta_vista",
        group_slug: "cash_eqs",
        claim_key: "flowsCheckingGastos-855",
        movement_id: null,
      },
    ];
    const splitNov27 = splitCheckingWithdrawalAgainstDeposits(
      {
        occurred_on: "2017-11-27",
        amount_clp: -300_000,
        description: "Agustinas Transf. Internet a otro Bancos",
      },
      deposits,
      {
        splittablePool: createSplittableInternalTransferPool(deposits),
        usedDepositKeys: new Set(),
        withdrawalAccountId: corrienteId,
        withdrawalCategorySlug: "cuenta_corriente",
      }
    );
    expect(splitNov27.internalClp).toBe(0);
    expect(splitNov27.gastosClp).toBe(300_000);

    const splitNov30 = splitCheckingWithdrawalAgainstDeposits(
      {
        occurred_on: "2017-11-30",
        amount_clp: -300_000,
        description: "Agustinas Transf. Internet a otro Bancos",
      },
      deposits,
      {
        splittablePool: createSplittableInternalTransferPool(deposits),
        usedDepositKeys: new Set(),
        withdrawalAccountId: corrienteId,
        withdrawalCategorySlug: "cuenta_corriente",
      }
    );
    expect(splitNov30.internalClp).toBe(0);
    expect(splitNov30.gastosClp).toBe(300_000);
  });

  it("does not emit orphan gastos on cuenta vista Nov 2017 wire", () => {
    const vistaId = 99;
    const deposits: DepositMatchCandidate[] = [
      {
        occurred_on: "2017-11-30",
        amount_clp: 37_914,
        account_id: 10,
        category_slug: "cuenta_corriente",
        group_slug: "cash_eqs",
        claim_key: "flowsCheckingGastos-901",
        movement_id: null,
      },
    ];
    const split = splitCheckingWithdrawalAgainstDeposits(
      {
        occurred_on: "2017-11-30",
        amount_clp: -200_000,
        description: "Transf. Internet a otro Bancos",
      },
      deposits,
      {
        splittablePool: createSplittableInternalTransferPool(deposits),
        usedDepositKeys: new Set(),
        withdrawalAccountId: vistaId,
        withdrawalCategorySlug: "cuenta_vista",
      }
    );
    expect(split.internalClp).toBe(0);
    expect(split.gastosClp).toBe(200_000);
    expect(split.investmentDeposit).toBeNull();
  });

  it("never pairs a CMR card payment with a same-day vista traspaso credit, and keeps it out of gastos", () => {
    const vistaId = 99;
    const split = splitCheckingWithdrawalAgainstDeposits(
      {
        occurred_on: "2019-07-15",
        amount_clp: -365_970,
        description: "PAGO EN LINEA PROM. CMR FALABE",
      },
      [],
      {
        splittablePool: createSplittableInternalTransferPool([]),
        usedDepositKeys: new Set(),
        withdrawalAccountId: vistaId,
        withdrawalCategorySlug: "cuenta_vista",
      }
    );
    expect(split.internalClp).toBe(0);
    expect(split.gastosClp).toBe(365_970);

    const vistaIdReal = requireVistaId();
    const movId = insertCheckingCartolaWithdrawal(
      vistaIdReal,
      "2099-07-15",
      -365_970,
      "PAGO EN LINEA PROM. CMR FALABE",
      { cartolaMonth: "2099-07", branch: "93", doc: "0114200", idx: 8811 }
    );
    const lines = buildCheckingGastosLines({
      accountId: vistaIdReal,
      depositCandidates: [],
      checkingCredits: [
        {
          occurred_on: "2099-07-15",
          amount_clp: 365_970,
          note:
            "import:cartola|2099-07|401|Traspaso Internet desde Cta.Ct|on:2099-07-15|amt:365970|idx:10",
        },
      ],
    });
    // A card payment: the card's lines carry the spending.
    expect(lines.find((l) => l.statement_line_id === movId)).toBeUndefined();
    deleteCheckingMovements([movId]);
  });

  it("pairs cross-account wire with cuenta vista inflow on same day", () => {
    const corrienteId = 10;
    const vistaId = 99;
    const deposits: DepositMatchCandidate[] = [
      {
        occurred_on: "2019-08-01",
        amount_clp: 800_000,
        account_id: vistaId,
        category_slug: "cuenta_vista",
        group_slug: "cash_eqs",
        claim_key: "flowsCheckingGastos-980",
        movement_id: null,
      },
    ];
    const split = splitCheckingWithdrawalAgainstDeposits(
      {
        occurred_on: "2019-08-01",
        amount_clp: -800_000,
        description: "Transf. Internet a otro Bancos",
      },
      deposits,
      {
        splittablePool: createSplittableInternalTransferPool(deposits),
        usedDepositKeys: new Set(),
        withdrawalAccountId: corrienteId,
        withdrawalCategorySlug: "cuenta_corriente",
      }
    );
    expect(split.internalClp).toBe(800_000);
    expect(split.gastosClp).toBe(0);
  });

  it("attaches auto deposit-match notes to paired checking gastos lines", () => {
    const corrienteId = checkingAccountId();
    const vistaId = requireVistaId();
    const movId = insertCheckingCartolaWithdrawal(
      corrienteId,
      "2099-07-12",
      -250_000,
      "Transf. Internet a otro Bancos",
      { cartolaMonth: "2099-07", idx: 9998832 }
    );
    try {
      const drafts = buildCheckingGastosLines({
        accountId: corrienteId,
        depositCandidates: [
          {
            occurred_on: "2099-07-12",
            amount_clp: 250_000,
            account_id: vistaId,
            category_slug: "cuenta_vista",
            group_slug: "cash_eqs",
            claim_key: "flowsCheckingGastos-auto-note",
            movement_id: null,
          },
        ],
        checkingCredits: [],
      }).filter((l) => l.statement_line_id === movId);
      expect(drafts).toHaveLength(1);
      const sample = drafts[0]!;
      expect(sample.auto_deposit_match_note).toBe(
        `auto:deposit-match|acct:${vistaId}|date:2099-07-12|amt:250000`
      );
      expect(isAutoDepositMatchedPurchaseNote(sample.auto_deposit_match_note ?? "")).toBe(true);
      expect(sample.deposit_match?.length ?? 0).toBeGreaterThan(0);
      const enriched = enrichFlowLinesWithPurchaseNotes([sample]);
      expect(isAutoDepositMatchedPurchaseNote(enriched[0]!.purchase_notes)).toBe(true);
    } finally {
      deleteCheckingMovements([movId]);
    }
  });

  it("allocates two checking wires against one lump-sum reserva deposit on the same day", () => {
    const deposits: DepositMatchCandidate[] = [
      {
        occurred_on: "2025-01-09",
        amount_clp: 10_000_000,
        account_id: 1,
        category_slug: "fondo_reserva",
        group_slug: "cash_eqs",
        claim_key: "flowsCheckingGastos-1020",
        movement_id: null,
      },
    ];
    const pool = createSplittableInternalTransferPool(deposits);
    const withdrawal = {
      occurred_on: "2025-01-09",
      amount_clp: -5_000_000,
      description: "TRASPASO A FONDO RESERVA",
    };
    expect(withdrawalMatchesInternalCashTransfer(withdrawal, deposits, 3, pool)).toBe(true);
    expect(withdrawalMatchesInternalCashTransfer(withdrawal, deposits, 3, pool)).toBe(true);
    expect(pool.get("flowsCheckingGastos-1020")).toBe(0);
  });

  it("does not allocate splittable reserva pool to checking wires on other days", () => {
    const deposits: DepositMatchCandidate[] = [
      {
        occurred_on: "2025-01-09",
        amount_clp: 10_000_000,
        account_id: 21,
        category_slug: "fondo_reserva",
        group_slug: "cash_eqs",
        claim_key: "flowsCheckingGastos-1041",
        movement_id: null,
      },
    ];
    const pool = createSplittableInternalTransferPool(deposits);
    expect(
      withdrawalMatchesInternalCashTransfer(
        { occurred_on: "2025-01-06", amount_clp: -245_000 },
        deposits,
        3,
        pool
      )
    ).toBe(false);
    expect(pool.get("flowsCheckingGastos-1041")).toBe(10_000_000);
  });

  it("does not partial-match May 2023 555k wire against unrelated ahorro month deposit", () => {
    const deposits: DepositMatchCandidate[] = [
      {
        occurred_on: "2023-05-31",
        amount_clp: 527_950,
        account_id: 23,
        category_slug: "cuenta_ahorro_vivienda",
        group_slug: "cash_eqs",
        claim_key: "flowsCheckingGastos-1083",
        movement_id: null,
      },
      {
        occurred_on: "2023-05-02",
        amount_clp: 250_000,
        account_id: 20,
        category_slug: "fintual_risky_norris",
        group_slug: "brokerage",
        claim_key: "flowsCheckingGastos-1090",
        movement_id: null,
      },
    ];
    const split = splitCheckingWithdrawalAgainstDeposits(
      { occurred_on: "2023-05-05", amount_clp: -555_000 },
      deposits,
      {
        splittablePool: createSplittableInternalTransferPool(deposits),
        usedDepositKeys: new Set(),
        withdrawalAccountId: 1,
        withdrawalCategorySlug: "cuenta_corriente",
      }
    );
    expect(split.internalClp).toBe(0);
    expect(split.gastosClp).toBe(555_000);
    expect(split.investmentDeposit).toBeNull();
  });

  it("does not consume fondo reserva pool for unrelated same-day spending (Nov 2025 comunidad)", () => {
    const deposits: DepositMatchCandidate[] = [
      {
        occurred_on: "2025-11-17",
        amount_clp: 100_000,
        account_id: 21,
        category_slug: "fondo_reserva",
        group_slug: "cash_eqs",
        claim_key: "flowsCheckingGastos-1115",
        movement_id: null,
      },
    ];
    const split = splitCheckingWithdrawalAgainstDeposits(
      {
        occurred_on: "2025-11-17",
        amount_clp: -86_668,
        description: "0560112904 Transf a COMUNIDAD EDIFICIO",
      },
      deposits,
      {
        splittablePool: createSplittableInternalTransferPool(deposits),
        usedDepositKeys: new Set(),
        withdrawalAccountId: 99,
        withdrawalCategorySlug: "cuenta_corriente",
      }
    );
    expect(split.internalClp).toBe(0);
    expect(split.gastosClp).toBe(86_668);
  });

  it("splits a reserva wire: 4M reserva internal + 600k acciones deposit", () => {
    const corrienteId = checkingAccountId();
    // One wire funds a lump-sum reserva deposit and, with the rest, a same-day stock deposit.
    const deposits: DepositMatchCandidate[] = [
      {
        occurred_on: "2099-03-10",
        amount_clp: 4_000_000,
        account_id: 990_031,
        category_slug: "fondo_reserva",
        group_slug: "cash_eqs",
        claim_key: "flowsCheckingGastos-split-reserva",
        movement_id: null,
      },
      {
        occurred_on: "2099-03-10",
        amount_clp: 600_000,
        account_id: 990_032,
        category_slug: "spy",
        group_slug: "brokerage",
        claim_key: "flowsCheckingGastos-split-spy",
        movement_id: null,
      },
    ];
    const split = splitCheckingWithdrawalAgainstDeposits(
      { occurred_on: "2099-03-10", amount_clp: -4_600_000, description: "TRASPASO A FONDO RESERVA" },
      deposits,
      {
        splittablePool: createSplittableInternalTransferPool(deposits),
        usedDepositKeys: new Set<string>(),
        withdrawalAccountId: corrienteId,
        withdrawalCategorySlug: "cuenta_corriente",
      }
    );
    expect(split.internalClp).toBe(4_000_000);
    expect(split.gastosClp).toBe(600_000);
    expect(split.investmentMatchClp).toBe(600_000);
    expect(split.investmentDeposit?.category_slug).toBe("spy");

    const movId = insertCheckingCartolaWithdrawal(
      corrienteId,
      "2099-03-10",
      -4_600_000,
      "TRASPASO A FONDO RESERVA",
      { cartolaMonth: "2099-03", idx: 9998833 }
    );
    try {
      const decLines = buildCheckingGastosLines({
        accountId: corrienteId,
        depositCandidates: deposits,
        checkingCredits: [],
      }).filter((l) => l.statement_line_id === movId);
      expect(decLines).toHaveLength(2);
      const gastos = decLines.find((l) => !l.checking_purchase_portion);
      const deposit = decLines.find((l) => l.checking_purchase_portion === "deposit");
      expect(gastos?.amount_clp).toBe(600_000);
      expect(gastos?.category_slug).toBe("deposits");
      expect(deposit?.amount_clp).toBe(4_000_000);
      expect(deposit?.category_slug).toBe("deposits");
      expect(gastos?.expense_month).toBe("2099-03");
    } finally {
      deleteCheckingMovements([movId]);
    }
  });

  it("Fintual reserva wires emit deposit-portion lines (excluded from gastos totals), not gastos", () => {
    const corrienteId = checkingAccountId();
    const movId = insertCheckingCartolaWithdrawal(
      corrienteId,
      "2099-01-14",
      -500_000,
      "0768106274 Transf a FINTUAL ADMINISTRADORA G",
      { cartolaMonth: "2099-01", idx: 9998834 }
    );
    const reserva: DepositMatchCandidate = {
      occurred_on: "2099-01-15",
      amount_clp: 500_000,
      account_id: 990_041,
      category_slug: "fondo_reserva",
      group_slug: "cash_eqs",
      claim_key: "flowsCheckingGastos-fintual-reserva",
      movement_id: null,
    };
    try {
      // Fintual wires are capital flows, not consumption. They emit deposit-portion lines (so the funded
      // Reserva2 deposit gets linked through the shared matcher) with the `deposits` category, which is
      // excluded from gastos totals — never a gastos-portion (consumption) line.
      const fintual = buildCheckingGastosLines({
        accountId: corrienteId,
        depositCandidates: [reserva],
        checkingCredits: [],
      }).filter((l) => l.statement_line_id === movId);
      expect(fintual).toHaveLength(1);
      expect(fintual[0]!.amount_clp).toBe(500_000);
      expect(fintual[0]!.checking_purchase_portion).toBe("deposit");
      expect(fintual[0]!.category_slug).toBe("deposits");
      // With no deposit to fund, the wire is still no gastos line.
      const unpaired = buildCheckingGastosLines({
        accountId: corrienteId,
        depositCandidates: [],
        checkingCredits: [],
      }).filter((l) => l.statement_line_id === movId);
      expect(unpaired).toEqual([]);
    } finally {
      deleteCheckingMovements([movId]);
    }
  });

  it("investment deposit match ignores cash/efectivo inflows", () => {
    const reservaId = 990_021;
    const deposits: DepositMatchCandidate[] = [
      {
        occurred_on: "2024-03-15",
        amount_clp: 500_000,
        account_id: reservaId,
        category_slug: "fondo_reserva",
        group_slug: "cash_eqs",
        claim_key: "flowsCheckingGastos-1196",
        movement_id: null,
      },
      {
        occurred_on: "2024-03-16",
        amount_clp: 500_000,
        account_id: 999_999,
        category_slug: "spy",
        group_slug: "brokerage",
        claim_key: "flowsCheckingGastos-1203",
        movement_id: null,
      },
    ];
    expect(
      matchWithdrawalToInvestmentDeposit(
        { occurred_on: "2024-03-16", amount_clp: -500_000 },
        deposits
      )?.category_slug
    ).toBe("spy");
    expect(isInvestmentDepositTarget("cash_eqs")).toBe(false);
    expect(isInvestmentDepositTarget("brokerage")).toBe(true);
  });

  it("matchWithdrawalToDeposit still matches any candidate", () => {
    const deposits: DepositMatchCandidate[] = [
      {
        occurred_on: "2024-03-15",
        amount_clp: 500_000,
        account_id: 1,
        category_slug: "fondo_reserva",
        group_slug: "cash_eqs",
        claim_key: "flowsCheckingGastos-1223",
        movement_id: null,
      },
    ];
    expect(
      matchWithdrawalToDeposit(
        { occurred_on: "2024-03-16", amount_clp: -500_000 },
        deposits
      )?.category_slug
    ).toBe("fondo_reserva");
  });

  it("uses stable purchase keys for checking gastos lines", () => {
    // Movement without a cartola note → legacy id-based key. Synthetic account per the
    // fixtures rule — hardcoding account_id 1 breaks on DBs where that id doesn't exist.
    const anyLeaf = (db.prepare(`SELECT id FROM asset_groups LIMIT 1`).get() as { id: number }).id;
    const acctId = Number(
      db
        .prepare(`INSERT INTO accounts (asset_group_id, name) VALUES (?, 'vitest-stable-key-acct')`)
        .run(anyLeaf).lastInsertRowid
    );
    const legacyId = Number(
      db
        .prepare(
          `INSERT INTO movements (account_id, occurred_on, amount, currency, note)
           VALUES (?, '2024-03-01', -1000, 'clp', 'manual|stable-key-test')`
        )
        .run(acctId).lastInsertRowid
    );
    try {
      expect(checkingGastosMovementPurchaseKey(legacyId)).toBe(`checking-mv:${legacyId}`);
    } finally {
      db.prepare(`DELETE FROM movements WHERE id = ?`).run(legacyId);
      db.prepare(`DELETE FROM accounts WHERE id = ?`).run(acctId);
    }
    // A cartola row → the stable key built from its note.
    const corrienteId = checkingAccountId();
    const cartolaId = insertCheckingCartolaWithdrawal(corrienteId, "2099-02-03", -7_000, "Compra ACME STORE", {
      cartolaMonth: "2099-02",
      idx: 9998835,
    });
    try {
      const full = db
        .prepare(`SELECT account_id, note FROM movements WHERE id = ?`)
        .get(cartolaId) as { account_id: number; note: string };
      const key = checkingGastosMovementPurchaseKey(cartolaId);
      expect(key).toBe(`checking-cartola:${corrienteId}:2099-02:2099-02-03:-7000:9998835`);
      expect(key).toBe(checkingCartolaStablePurchaseKey(full.account_id, full.note));
    } finally {
      deleteCheckingMovements([cartolaId]);
    }
  });

  it("assigns category to checking gastos movement when present in DB", () => {
    const corrienteId = checkingAccountId();
    const movId = insertCheckingCartolaWithdrawal(corrienteId, "2099-02-07", -8_000, "Compra ACME STORE", {
      cartolaMonth: "2099-02",
      idx: 9998836,
    });
    const key = checkingGastosMovementPurchaseKey(movId, "gastos");
    try {
      const payload = buildFlowsExpensesPayload();
      const line = payload.lines.find((ln) => ln.source === "checking" && ln.statement_line_id === movId);
      expect(line).toBeDefined();
      expect(line!.value_clp).toBe(8_000);
      expect(line!.category_slug).not.toBe("fun");

      expect(checkingGastosMovementBelongs(movId).ok).toBe(true);

      assignFlowExpenseLineCategory({
        source: "checking",
        lineId: movId,
        unique: true,
        categorySlug: "fun",
      });

      const after = buildFlowsExpensesPayload();
      const updated = after.lines.find((ln) => ln.source === "checking" && ln.statement_line_id === movId);
      expect(updated?.category_slug).toBe("fun");
      expect(updated?.category_unique).toBe(true);
    } finally {
      db.prepare(
        `DELETE FROM flow_categories WHERE rowid IN (SELECT rid FROM ${FLOW_CATEGORY_ROWS_SQL} WHERE account_id = ? AND purchase_key = ?)`
      ).run(corrienteId, key);
      deleteCheckingMovements([movId]);
    }
  });

  it("matches deposit within 3 days and exact CLP", () => {
    const deposits: DepositMatchCandidate[] = [
      {
        occurred_on: "2024-03-15",
        amount_clp: 500_000,
        account_id: 1,
        category_slug: "spy",
        group_slug: "brokerage",
        claim_key: "flowsCheckingGastos-1297",
        movement_id: null,
      },
    ];
    expect(
      matchWithdrawalToDeposit(
        { occurred_on: "2024-03-17", amount_clp: -500_000 },
        deposits
      )
    ).toEqual(deposits[0]);
    expect(
      matchWithdrawalToDeposit(
        { occurred_on: "2024-03-20", amount_clp: -500_000 },
        deposits
      )
    ).toBeNull();
    expect(
      matchWithdrawalToDeposit(
        { occurred_on: "2024-03-16", amount_clp: -500_001 },
        deposits
      )
    ).toBeNull();
  });

  it("excludes ledger anchor movements from gastos and cartola credit matching", () => {
    const accountId = requireVistaId();

    const depositId = db
      .prepare(
        `INSERT INTO movements (account_id, amount, currency, occurred_on, note, units_delta)
         VALUES (?, ?, 'clp', ?, ?, NULL)`
      )
      .run(accountId, 583_492, "2099-01-01", checkingLedgerAnchorNote("2099-02")).lastInsertRowid as number;

    const withdrawalId = db
      .prepare(
        `INSERT INTO movements (account_id, amount, currency, occurred_on, note, units_delta)
         VALUES (?, ?, 'clp', ?, ?, NULL)`
      )
      .run(accountId, -583_492, "2099-01-02", checkingLedgerAnchorNote("2099-02")).lastInsertRowid as number;

    expect(checkingGastosMovementBelongs(Number(depositId)).ok).toBe(false);
    expect(checkingGastosMovementBelongs(Number(withdrawalId)).ok).toBe(false);

    const credits = loadCheckingCredits(accountId);
    expect(credits.some((c) => c.note === checkingLedgerAnchorNote("2099-02"))).toBe(false);

    deleteCheckingMovements([Number(depositId), Number(withdrawalId)]);
  });

  it("checkingWithdrawalMayAutoMatchDeposit rejects named payee wires", () => {
    expect(checkingWithdrawalMayAutoMatchDeposit("Agustinas Transf a CORRADI DELGADO")).toBe(
      false
    );
    expect(checkingWithdrawalMayAutoMatchDeposit("Agustinas Transf. Internet a otro Bancos")).toBe(
      true
    );
  });

  it("autoMatchCategorySlugForDeposit splits checking vs investment targets", () => {
    expect(
      autoMatchCategorySlugForDeposit({
        category_slug: "cuenta_vista",
        group_slug: "cash_eqs",
      })
    ).toBe("checking_internal_transfer");
    expect(
      autoMatchCategorySlugForDeposit({
        category_slug: "cuenta_ahorro_vivienda",
        group_slug: "cash_eqs",
      })
    ).toBe("deposits");
    expect(
      autoMatchCategorySlugForDeposit({
        category_slug: "spy",
        group_slug: "brokerage",
      })
    ).toBe("deposits");
  });

  it("does not auto-match CORRADI wire against coincident cross-account inflow (Aug 2017)", () => {
    const corrienteId = 10;
    const split = splitCheckingWithdrawalAgainstDeposits(
      {
        occurred_on: "2017-08-29",
        amount_clp: -30_000,
        description: "Agustinas Transf a CORRADI DELGADO",
      },
      [
        {
          occurred_on: "2017-08-29",
          amount_clp: 30_000,
          account_id: 99,
          category_slug: "cuenta_vista",
          group_slug: "cash_eqs",
          claim_key: "flowsCheckingGastos-1391",
          movement_id: null,
        },
      ],
      {
        splittablePool: createSplittableInternalTransferPool([]),
        usedDepositKeys: new Set(),
        withdrawalAccountId: corrienteId,
        withdrawalCategorySlug: "cuenta_corriente",
      }
    );
    expect(split.internalClp).toBe(0);
    expect(split.gastosClp).toBe(30_000);
  });

  it("persists cleared category across payload rebuild", () => {
    const corrienteId = checkingAccountId();
    const vistaId = requireVistaId();

    const movementId = insertCheckingCartolaWithdrawal(
      corrienteId,
      "2099-08-10",
      -120_000,
      "Transf. Internet a otro Bancos",
      { cartolaMonth: "2099-08", idx: 9998812 }
    );
    for (const portion of ["gastos", "deposit"] as const) {
      const key = checkingGastosMovementPurchaseKey(movementId, portion);
      db.prepare(
        `DELETE FROM flow_categories WHERE rowid IN (SELECT rid FROM ${FLOW_CATEGORY_ROWS_SQL} WHERE account_id = ? AND purchase_key = ?)`
      ).run(corrienteId, key);
    }
    const depositCandidates: DepositMatchCandidate[] = [
      {
        occurred_on: "2099-08-10",
        amount_clp: 120_000,
        account_id: vistaId,
        category_slug: "cuenta_vista",
        group_slug: "cash_eqs",
        claim_key: "flowsCheckingGastos-1429",
        movement_id: null,
      },
    ];

    const before = buildCheckingGastosLines({
      accountId: corrienteId,
      depositCandidates,
      checkingCredits: [],
    });
    const line = before.find((l) => l.statement_line_id === movementId);
    expect(line?.category_slug).toBe("checking_internal_transfer");

    assignFlowExpenseLineCategory({
      source: "checking",
      lineId: movementId,
      unique: true,
      clearCategory: true,
    });

    const after = buildCheckingGastosLines({
      accountId: corrienteId,
      depositCandidates,
      checkingCredits: [],
    });
    const updated = after.find((l) => l.statement_line_id === movementId);
    expect(updated?.category_slug).toBe("unclassified");
    expect(updated?.category_unique).toBe(true);

    deleteCheckingMovements([movementId]);
    for (const portion of ["gastos", "deposit"] as const) {
      const key = checkingGastosMovementPurchaseKey(movementId, portion);
      db.prepare(
        `DELETE FROM flow_categories WHERE rowid IN (SELECT rid FROM ${FLOW_CATEGORY_ROWS_SQL} WHERE account_id = ? AND purchase_key = ?)`
      ).run(corrienteId, key);
    }
  });
});

describe("internal-transfer timing helpers", () => {
  it("day-precision deposits match within the day gap in either direction", () => {
    const w = { occurred_on: "2026-05-10" };
    const dep = (d: string) => ({ occurred_on: d, category_slug: "fondo_reserva" });
    expect(depositMatchesInternalTransferTiming(w, dep("2026-05-12"))).toBe(true);
    expect(depositMatchesInternalTransferTiming(w, dep("2026-05-08"))).toBe(true);
    expect(depositMatchesInternalTransferTiming(w, dep("2026-05-14"))).toBe(false);
    expect(depositMatchesInternalTransferTiming(w, dep("2026-05-14"), 5)).toBe(true);
  });

  it("month-bucket deposits (cuenta ahorro) match by calendar month only", () => {
    const dep = (d: string) => ({ occurred_on: d, category_slug: "cuenta_ahorro_vivienda" });
    expect(
      depositMatchesInternalTransferTiming({ occurred_on: "2026-05-02" }, dep("2026-05-31"))
    ).toBe(true);
    expect(
      depositMatchesInternalTransferTiming({ occurred_on: "2026-06-01" }, dep("2026-05-31"))
    ).toBe(false);
  });

  it("ledger capital returns require the credit on/after the outflow (day precision)", () => {
    expect(ledgerCapitalReturnMatchesTiming("2026-05-12", "2026-05-10", "fondo_reserva", 3)).toBe(true);
    // credit BEFORE the outflow never matches, even inside the gap
    expect(ledgerCapitalReturnMatchesTiming("2026-05-09", "2026-05-10", "fondo_reserva", 3)).toBe(false);
    expect(ledgerCapitalReturnMatchesTiming("2026-05-20", "2026-05-10", "fondo_reserva", 3)).toBe(false);
    // month-bucket outflow: same calendar month, direction-free
    expect(
      ledgerCapitalReturnMatchesTiming("2026-05-03", "2026-05-31", "cuenta_ahorro_vivienda", 3)
    ).toBe(true);
  });
});

describe("internal transfers between the two checking accounts", () => {
  const credit = (own: boolean, occurred_on = "2018-05-07"): DepositMatchCandidate => ({
    occurred_on,
    amount_clp: 30_000,
    account_id: 2,
    category_slug: "cuenta_vista",
    group_slug: "cash_eqs",
    claim_key: `internal-traspaso-${own}-${occurred_on}`,
    movement_id: null,
    checking_own_traspaso: own,
  });

  it("pairs only the bank's own traspaso with a credit printed as one", () => {
    const traspaso = { occurred_on: "2018-05-07", amount_clp: -30_000, description: "Traspaso Internet a Cuentamática" };
    expect(withdrawalMatchesInternalCashTransfer(traspaso, [credit(true)], 3, undefined, 1)).toBe(true);
    // A third party's transfer into the other account funded by nobody.
    expect(withdrawalMatchesInternalCashTransfer(traspaso, [credit(false)], 3, undefined, 1)).toBe(false);
  });

  it("never pairs a wire to another bank with a checking credit", () => {
    const wire = { occurred_on: "2018-05-04", amount_clp: -30_000, description: "Transf. Internet a otro Bancos" };
    expect(withdrawalMatchesInternalCashTransfer(wire, [credit(false)], 3, undefined, 1)).toBe(false);
    expect(withdrawalMatchesInternalCashTransfer(wire, [credit(true)], 3, undefined, 1)).toBe(false);
  });

  it("leaves the credit to the real traspaso of the next day", () => {
    const used = new Set<string>();
    const deposits = [credit(true, "2019-02-01")];
    const opts = { splittablePool: new Map<string, number>(), usedDepositKeys: used, withdrawalAccountId: 1, withdrawalCategorySlug: "cuenta_corriente" };
    const wire = splitCheckingWithdrawalAgainstDeposits(
      { occurred_on: "2019-01-31", amount_clp: -30_000, description: "Transf. Internet a otro Bancos" },
      deposits,
      opts
    );
    expect(wire.internalClp).toBe(0);
    const traspaso = splitCheckingWithdrawalAgainstDeposits(
      { occurred_on: "2019-02-01", amount_clp: -30_000, description: "Traspaso Internet a Cta. Cte." },
      deposits,
      opts
    );
    expect(traspaso.internalClp).toBe(30_000);
  });

  it("reads the bank's own traspaso wording on both sides", () => {
    expect(isCheckingOwnTraspasoInflow("Traspaso Internet desde Cta.Ct")).toBe(true);
    expect(isCheckingOwnTraspasoInflow("Agustinas Traspaso Internet de Cuenta Vista")).toBe(true);
    expect(isCheckingOwnTraspasoInflow("0012345678 Transf. Ana P")).toBe(false);
    expect(isCheckingOwnTraspasoInflow("Traspaso con la Cuenta N° 001000000000")).toBe(false);
    expect(isCheckingOwnTraspasoOutflow("Traspaso Internet a Cta. Cte.")).toBe(true);
    expect(isCheckingOwnTraspasoOutflow("Traspaso a Cuenta Vista 10% AFP")).toBe(true);
    expect(isCheckingOwnTraspasoOutflow("Transf. Internet a otro Bancos")).toBe(false);
    expect(isCheckingOwnTraspasoOutflow("Traspaso a Cuenta de Otro Banco")).toBe(false);
  });
});

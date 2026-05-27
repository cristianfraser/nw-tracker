import { describe, expect, it } from "vitest";
import {
  assignCheckingGastosMovementCategory,
  cartolaDescriptionFromNote,
  cartolaDocumentFromNote,
  checkingGastosMovementBelongs,
  checkingGastosMovementPurchaseKey,
  buildCheckingGastosLines,
  computeMercadoCapitalesInternalTransferMonths,
  createSplittableInternalTransferPool,
  depositMatchesInternalTransferTiming,
  fondoReservaAccountId,
  loadDepositMatchCandidates,
  splitCheckingWithdrawalAgainstDeposits,
  isDapAbonoDescription,
  isExcludedCheckingWithdrawal,
  isInvestmentDepositTarget,
  isMercadoCapitalesCargoDescription,
  matchWithdrawalToDeposit,
  matchWithdrawalToInvestmentDeposit,
  withdrawalIsReversedByDapAbono,
  withdrawalMatchesInternalCashTransfer,
  withdrawalMatchesReservaDeposit,
  type CheckingCartolaCredit,
  type DepositMatchCandidate,
} from "./flowsCheckingGastos.js";
import { buildFlowsCreditCardExpensesPayload } from "./flowsCreditCardExpenses.js";

describe("flowsCheckingGastos", () => {
  it("builds checking gastos lines when cuenta corriente exists", () => {
    const lines = buildCheckingGastosLines();
    expect(lines.length).toBeGreaterThan(0);
    const deposits = lines.filter((l) => l.category_slug === "deposits");
    expect(deposits.length).toBeGreaterThan(0);
  });

  it("parses cartola description from movement note", () => {
    const note =
      "import:cartola|2024-03|Las Condes|TRASPASO A FINTUAL|doc:123";
    expect(cartolaDescriptionFromNote(note)).toBe("TRASPASO A FINTUAL");
    expect(cartolaDocumentFromNote(note)).toBe("123");
  });

  it("detects mercado capitales cargo and DAP abono descriptions", () => {
    expect(isMercadoCapitalesCargoDescription("Cargo Mercado Capitales")).toBe(true);
    expect(isMercadoCapitalesCargoDescription("00350323026433811444")).toBe(true);
    expect(isMercadoCapitalesCargoDescription("TRASPASO A FINTUAL")).toBe(false);
    expect(isDapAbonoDescription("DAP 026434101963 ABONADO")).toBe(true);
    expect(isDapAbonoDescription("Depósito con Vales Vista")).toBe(false);
  });

  it("treats DAP-reversed MC cargos as non-gastos (March 2024 doc pairing)", () => {
    const credits: CheckingCartolaCredit[] = [
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
    const credits: CheckingCartolaCredit[] = [
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

  it("excludes traspaso a cuenta vista (AFP 10%) from checking gastos", () => {
    const lines = buildCheckingGastosLines();
    const vistaAfpIds = new Set([637, 640, 1712]);
    const matched = lines.filter(
      (l) => l.source === "checking" && vistaAfpIds.has(l.statement_line_id)
    );
    expect(matched).toEqual([]);
  });

  it("excludes known DAP-reversed MC cargos from checking gastos lines", () => {
    const lines = buildCheckingGastosLines();
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

    expect(mcMerchants("2024-03")).toEqual([]);
    expect(mcMerchants("2024-08")).toEqual([]);
    expect(mcMerchants("2024-11")).toEqual([
      expect.objectContaining({ amount: 19_799_625, merchant: "Cargo Mercado Capitales" }),
    ]);
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
    expect(isExcludedCheckingWithdrawal("Cristian Fraser - Santander")).toBe(true);
    expect(isExcludedCheckingWithdrawal("MONTO CANCELADO")).toBe(true);
    expect(isExcludedCheckingWithdrawal("PAGO TARJETA DE CREDITO")).toBe(true);
    expect(isExcludedCheckingWithdrawal("Traspaso Internet a T. Crédito")).toBe(true);
    expect(isExcludedCheckingWithdrawal("Traspaso Internet a Cuentamática")).toBe(true);
    expect(isExcludedCheckingWithdrawal("Traspaso a Cuenta Vista 10% AFP")).toBe(true);
    expect(isExcludedCheckingWithdrawal("Traspaso a Cuenta Vista 10%")).toBe(true);
    expect(isExcludedCheckingWithdrawal("Egreso por Compra de Divisas")).toBe(true);
    expect(isExcludedCheckingWithdrawal("Traspaso Internet a Línea Crédito")).toBe(true);
    expect(isExcludedCheckingWithdrawal("TRASPASO A FINTUAL")).toBe(false);
    expect(isExcludedCheckingWithdrawal("TRASPASO A FONDO RESERVA")).toBe(true);
    expect(isExcludedCheckingWithdrawal("DEPOSITO A RESERVA FINTUAL")).toBe(true);
  });

  it("treats checking outflows paired with cash/efectivo deposits as internal", () => {
    const reservaId = fondoReservaAccountId();
    if (reservaId == null) return;
    const deposits: DepositMatchCandidate[] = [
      {
        occurred_on: "2024-03-15",
        amount_clp: 500_000,
        account_id: reservaId,
        category_slug: "fondo_reserva",
        group_slug: "cash_eqs",
      },
      {
        occurred_on: "2024-03-15",
        amount_clp: 500_000,
        account_id: 999_999,
        category_slug: "spy",
        group_slug: "brokerage",
      },
    ];
    expect(
      withdrawalMatchesInternalCashTransfer(
        { occurred_on: "2024-03-16", amount_clp: -500_000 },
        deposits
      )
    ).toBe(true);
    expect(
      withdrawalMatchesReservaDeposit(
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

  it("shows transf a otro bancos paired with cuenta ahorro deposit as deposits category", () => {
    const lines = buildCheckingGastosLines();
    const hit = lines.find((l) => l.statement_line_id === 624);
    expect(hit?.category_slug).toBe("deposits");
    expect(hit?.checking_purchase_portion).toBe("deposit");
  });

  it("allocates two checking wires against one lump-sum reserva deposit on the same day", () => {
    const deposits: DepositMatchCandidate[] = [
      {
        occurred_on: "2025-01-09",
        amount_clp: 10_000_000,
        account_id: 1,
        category_slug: "fondo_reserva",
        group_slug: "cash_eqs",
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
    expect(pool.get("1|2025-01-09|10000000")).toBe(0);
  });

  it("does not allocate splittable reserva pool to checking wires on other days", () => {
    const deposits: DepositMatchCandidate[] = [
      {
        occurred_on: "2025-01-09",
        amount_clp: 10_000_000,
        account_id: 21,
        category_slug: "fondo_reserva",
        group_slug: "cash_eqs",
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
    expect(pool.get("21|2025-01-09|10000000")).toBe(10_000_000);
  });

  it("matches Jan 2025 Fintual wires against lump-sum reserva deposit in DB", () => {
    const deposits = loadDepositMatchCandidates();
    const pool = createSplittableInternalTransferPool(deposits);
    const withdrawal = {
      occurred_on: "2025-01-09",
      amount_clp: -5_000_000,
      description: "0768106274 Transf a FINTUAL ADMINISTRADORA G",
    };
    expect(
      deposits.some((d) => d.category_slug === "fondo_reserva" && d.amount_clp === 10_000_000)
    ).toBe(true);
    expect(withdrawalMatchesInternalCashTransfer(withdrawal, deposits, 3, pool)).toBe(true);
    expect(withdrawalMatchesInternalCashTransfer(withdrawal, deposits, 3, pool)).toBe(true);
  });

  it("does not partial-match May 2023 555k wire against unrelated ahorro month deposit", () => {
    const deposits: DepositMatchCandidate[] = [
      {
        occurred_on: "2023-05-31",
        amount_clp: 527_950,
        account_id: 23,
        category_slug: "cuenta_ahorro_vivienda",
        group_slug: "cash_eqs",
      },
      {
        occurred_on: "2023-05-02",
        amount_clp: 250_000,
        account_id: 20,
        category_slug: "fintual_risky_norris",
        group_slug: "brokerage",
      },
    ];
    const split = splitCheckingWithdrawalAgainstDeposits(
      { occurred_on: "2023-05-05", amount_clp: -555_000 },
      deposits,
      {
        splittablePool: createSplittableInternalTransferPool(deposits),
        usedDepositKeys: new Set(),
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
      }
    );
    expect(split.internalClp).toBe(0);
    expect(split.gastosClp).toBe(86_668);
  });

  it("splits Dec 2024 wire: 4M reserva internal + 600k acciones gasto", () => {
    const deposits = loadDepositMatchCandidates();
    const pool = createSplittableInternalTransferPool(deposits);
    const used = new Set<string>();
    const split = splitCheckingWithdrawalAgainstDeposits(
      { occurred_on: "2024-12-10", amount_clp: -4_600_000 },
      deposits,
      { splittablePool: pool, usedDepositKeys: used }
    );
    expect(split.internalClp).toBe(4_000_000);
    expect(split.gastosClp).toBe(600_000);
    expect(split.investmentDeposit?.category_slug).toBe("spy");

    const lines = buildCheckingGastosLines().filter((l) => l.statement_line_id === 1374);
    const dec10Gastos = lines.find((l) => !l.checking_purchase_portion);
    const dec10Deposit = lines.find((l) => l.checking_purchase_portion === "deposit");
    expect(dec10Gastos?.amount_clp).toBe(600_000);
    expect(dec10Gastos?.category_slug).toBe("deposits");
    expect(dec10Deposit?.amount_clp).toBe(4_000_000);
    expect(dec10Deposit?.category_slug).toBe("deposits");
    expect(dec10Gastos?.expense_month).toBe("2024-12");
  });

  it("excludes duplicate Fintual reserva wires from Jan 2025 gastos", () => {
    const lines = buildCheckingGastosLines();
    const fintualJan9 = lines.filter(
      (l) =>
        l.source === "checking" &&
        l.expense_month === "2025-01" &&
        l.merchant?.includes("FINTUAL")
    );
    expect(fintualJan9.some((l) => l.statement_line_id === 1399)).toBe(false);
    expect(fintualJan9.some((l) => l.statement_line_id === 1400)).toBe(false);
  });

  it("investment deposit match ignores cash/efectivo inflows", () => {
    const reservaId = fondoReservaAccountId();
    if (reservaId == null) return;
    const deposits: DepositMatchCandidate[] = [
      {
        occurred_on: "2024-03-15",
        amount_clp: 500_000,
        account_id: reservaId,
        category_slug: "fondo_reserva",
        group_slug: "cash_eqs",
      },
      {
        occurred_on: "2024-03-16",
        amount_clp: 500_000,
        account_id: 999_999,
        category_slug: "spy",
        group_slug: "brokerage",
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
    expect(checkingGastosMovementPurchaseKey(42)).toBe("checking-mv:42");
  });

  it("assigns category to checking gastos movement when present in DB", () => {
    const payload = buildFlowsCreditCardExpensesPayload();
    const line = payload.lines.find((ln) => ln.source === "checking" && ln.amount_clp > 0);
    if (!line) return;

    expect(checkingGastosMovementBelongs(line.statement_line_id).ok).toBe(true);

    assignCheckingGastosMovementCategory({
      movementId: line.statement_line_id,
      unique: true,
      categorySlug: "fun",
    });

    const after = buildFlowsCreditCardExpensesPayload();
    const updated = after.lines.find(
      (ln) => ln.source === "checking" && ln.statement_line_id === line.statement_line_id
    );
    expect(updated?.category_slug).toBe("fun");
    expect(updated?.category_unique).toBe(true);
  });

  it("matches deposit within 3 days and exact CLP", () => {
    const deposits: DepositMatchCandidate[] = [
      {
        occurred_on: "2024-03-15",
        amount_clp: 500_000,
        account_id: 1,
        category_slug: "spy",
        group_slug: "brokerage",
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
});

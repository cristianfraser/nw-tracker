import { describe, expect, it } from "vitest";
import { db } from "./db.js";
import { checkingAccountId } from "./checkingCartolaImport.js";
import { cartolaCashAccountIdOptional } from "./movementBalanceCashAccounts.js";
import {
  buildFlowsCheckingIncomePayload,
} from "./flowsCheckingInflows.js";
import {
  isExcludedCheckingInflow,
} from "./flowsCheckingGastos.js";

function insertCheckingCartolaCredit(
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
      `INSERT INTO movements (account_id, amount_clp, occurred_on, note, units_delta)
       VALUES (?, ?, ?, ?, NULL)`
    )
    .run(accountId, amountClp, occurredOn, note);
  return Number(ins.lastInsertRowid);
}

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
      `INSERT INTO movements (account_id, amount_clp, occurred_on, note, units_delta)
       VALUES (?, ?, ?, ?, NULL)`
    )
    .run(accountId, amountClp, occurredOn, note);
  return Number(ins.lastInsertRowid);
}

function deleteCheckingMovements(ids: readonly number[]): void {
  if (ids.length === 0) return;
  const placeholders = ids.map(() => "?").join(", ");
  db.prepare(`DELETE FROM movements WHERE id IN (${placeholders})`).run(...ids);
}

function deleteManualIncome(ids: readonly number[]): void {
  if (ids.length === 0) return;
  const placeholders = ids.map(() => "?").join(", ");
  db.prepare(`DELETE FROM income_entries WHERE id IN (${placeholders})`).run(...ids);
}

describe("flowsCheckingInflows", () => {
  it("excludes DAP ABONADO credits paired with Mercado Capitales cargo", () => {
    const corrienteId = checkingAccountId();
    const cargoId = insertCheckingCartolaWithdrawal(
      corrienteId,
      "2099-08-01",
      -10_000_000,
      "00350323026433811444",
      { cartolaMonth: "2099-08", doc: "3381144", idx: 9998701 }
    );
    const abonoId = insertCheckingCartolaCredit(
      corrienteId,
      "2099-08-05",
      10_050_000,
      "DAP 026433811444 ABONADO",
      { cartolaMonth: "2099-08", doc: "3811444", idx: 9998702 }
    );

    const payload = buildFlowsCheckingIncomePayload();
    expect(payload.lines.some((l) => l.movement_id === abonoId)).toBe(false);

    deleteCheckingMovements([cargoId, abonoId]);
  });

  it("excludes corriente↔vista internet traspaso credits by description", () => {
    expect(
      isExcludedCheckingInflow("TRASPASO INTERNET DESDE CTA. CT.")
    ).toBe(true);
    expect(isExcludedCheckingInflow("TRASPASO INTERNET A CTA. CTE.")).toBe(true);
    expect(isExcludedCheckingInflow("Traspaso Internet de Cuenta Vista")).toBe(true);
    expect(isExcludedCheckingInflow("Traspaso Internet a Cuenta Vista")).toBe(true);
  });

  it("excludes Buda.com crypto exchange transfer credits by description", () => {
    expect(isExcludedCheckingInflow("0764155289 Transf. BUDA COM SPA")).toBe(true);
    expect(isExcludedCheckingInflow("Transf. BUDA COM SPA")).toBe(true);
    expect(isExcludedCheckingInflow("TRANSFERENCIA REMUNERACIONES EMPRESA SA")).toBe(false);
  });

  it("excludes AFP 10% retiro checking abonos by description", () => {
    expect(isExcludedCheckingInflow("Abono 10% AFP")).toBe(true);
    expect(isExcludedCheckingInflow("0769604243 RET O ANTI PREV AFP UNO")).toBe(true);
  });

  it("excludes checking credits paired with AFP retiro ledger rows (bidirectional date lag)", () => {
    const corrienteId = checkingAccountId();
    const afpId = db
      .prepare(
        `SELECT a.id FROM accounts a
         JOIN asset_groups g ON g.id = a.asset_group_id
         WHERE g.slug LIKE '%__afp' OR g.slug = 'afp'
         LIMIT 1`
      )
      .get() as { id: number } | undefined;
    if (afpId == null) return;

    const retiroId = Number(
      db
        .prepare(
          `INSERT INTO movements (account_id, amount_clp, occurred_on, note, units_delta)
           VALUES (?, ?, ?, ?, NULL)`
        )
        .run(
          afpId.id,
          -1_019_948,
          "2099-03-29",
          "import:excel|retiro-10pct|UNO-Fondo-A|209903|vitest-retiro",
        ).lastInsertRowid
    );
    const creditId = insertCheckingCartolaCredit(
      corrienteId,
      "2099-03-17",
      1_019_948,
      "ABONO TRANSFERENCIA ELECTRONICA",
      { cartolaMonth: "2099-03", idx: 9998301 }
    );

    const payload = buildFlowsCheckingIncomePayload();
    expect(payload.lines.some((l) => l.movement_id === creditId)).toBe(false);

    deleteCheckingMovements([retiroId, creditId]);
  });

  it("includes generic salary-like abonos", () => {
    const corrienteId = checkingAccountId();
    const creditId = insertCheckingCartolaCredit(
      corrienteId,
      "2099-06-15",
      3_500_000,
      "TRANSFERENCIA REMUNERACIONES EMPRESA SA",
      { cartolaMonth: "2099-06", idx: 9998601 }
    );

    const payload = buildFlowsCheckingIncomePayload();
    const line = payload.lines.find((l) => l.movement_id === creditId);
    expect(line).toBeDefined();
    expect(line?.amount_clp).toBe(3_500_000);
    expect(line?.description).toContain("REMUNERACIONES");

    deleteCheckingMovements([creditId]);
  });

  it("excludes Fintual and reserva incoming transfers by description", () => {
    expect(isExcludedCheckingInflow("0768106274 Transf a FINTUAL ADMINISTRADORA G")).toBe(
      true
    );
    expect(isExcludedCheckingInflow("0768106274 Transf. Fintual AGF")).toBe(true);
    expect(isExcludedCheckingInflow("TRASPASO A FONDO RESERVA")).toBe(true);
  });

  it("excludes checking credits paired with net-worth account withdrawals (Fintual reserva lag)", () => {
    const corrienteId = checkingAccountId();
    const reservaId = db
      .prepare(
        `SELECT a.id FROM accounts a
         JOIN asset_groups g ON g.id = a.asset_group_id
         WHERE g.slug LIKE '%__fondo_reserva' OR g.slug = 'fondo_reserva'
         LIMIT 1`
      )
      .get() as { id: number } | undefined;
    if (reservaId == null) return;

    const withdrawalId = Number(
      db
        .prepare(
          `INSERT INTO movements (account_id, amount_clp, occurred_on, note, units_delta)
           VALUES (?, ?, ?, ?, ?)`
        )
        .run(
          reservaId.id,
          -4_400_000,
          "2099-03-06",
          "import:fintual|cert|movement|vitest|day=2099-03-06|flow_kind=deposit_clp",
          -1
        ).lastInsertRowid
    );
    const creditId = insertCheckingCartolaCredit(
      corrienteId,
      "2099-03-09",
      4_400_000,
      "ABONO TRANSFERENCIA ELECTRONICA",
      { cartolaMonth: "2099-03", idx: 9998401 }
    );

    const payload = buildFlowsCheckingIncomePayload();
    expect(payload.lines.some((l) => l.movement_id === creditId)).toBe(false);

    deleteCheckingMovements([withdrawalId, creditId]);
  });

  it("excludes credits paired with internal checking withdrawals", () => {
    const corrienteId = checkingAccountId();
    const vistaId = cartolaCashAccountIdOptional("cuenta_vista");
    if (vistaId == null) return;

    const withdrawalId = insertCheckingCartolaWithdrawal(
      corrienteId,
      "2099-07-01",
      -500_000,
      "Transf. Internet a otro Bancos",
      { cartolaMonth: "2099-07", idx: 9998501 }
    );
    const creditId = insertCheckingCartolaCredit(
      vistaId,
      "2099-07-01",
      500_000,
      "ABONO TRANSFERENCIA",
      { cartolaMonth: "2099-07", idx: 9998502 }
    );

    const payload = buildFlowsCheckingIncomePayload();
    expect(payload.lines.some((l) => l.movement_id === creditId)).toBe(false);

    deleteCheckingMovements([withdrawalId, creditId]);
  });

  it("returns manual income_entries alongside cartola lines", () => {
    const ins = db
      .prepare(
        `INSERT INTO income_entries (amount_clp, received_on, source, note)
         VALUES (?, ?, ?, ?)`
      )
      .run(250_000, "2099-05-01", "Bono", "vitest-manual-income");
    const manualId = Number(ins.lastInsertRowid);

    const payload = buildFlowsCheckingIncomePayload();
    expect(payload.manual.some((m) => m.id === manualId)).toBe(true);
    expect(payload.manual.find((m) => m.id === manualId)?.origin).toBe("manual");

    deleteManualIncome([manualId]);
  });

  it("does not return Excel-imported income_entries in manual list", () => {
    const ins = db
      .prepare(
        `INSERT INTO income_entries (amount_clp, received_on, source, note)
         VALUES (?, ?, ?, ?)`
      )
      .run(1, "2099-04-01", "Excel", "import:excel|flujos|Gasto mensual|Ingreso");
    const excelId = Number(ins.lastInsertRowid);

    const payload = buildFlowsCheckingIncomePayload();
    expect(payload.manual.some((m) => m.id === excelId)).toBe(false);

    deleteManualIncome([excelId]);
  });
});

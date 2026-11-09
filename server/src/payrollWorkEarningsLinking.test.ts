import { describe, expect, it } from "vitest";
import { db } from "./db.js";
import { checkingAccountId } from "./checkingCartolaImport.js";
import {
  findPayrollAutoLinkMovement,
  PAYROLL_LINK_REMUNERACION_TOLERANCE_CLP,
  findUsPayrollAutoLinkMovement,
  type PayrollLinkCandidate,
} from "./payrollWorkEarningsLinking.js";

function insertRemuneracionCredit(
  occurredOn: string,
  amountClp: number,
  idx: number
): number {
  const accountId = checkingAccountId();
  const note =
    `import:cartola|${occurredOn.slice(0, 7)}|G.Finanzas|` +
    `0001234567 REMUNERACION    EJEMPLOSOFT|on:${occurredOn}|amt:${amountClp}|idx:${idx}`;
  const ins = db
    .prepare(
      `INSERT INTO movements (account_id, amount, currency, occurred_on, note, units_delta)
       VALUES (?, ?, 'clp', ?, ?, NULL)`
    )
    .run(accountId, amountClp, occurredOn, note);
  return Number(ins.lastInsertRowid);
}

function asCandidate(
  movementId: number,
  receivedOn: string,
  amountClp: number,
  opts?: { description?: string; cartola_note?: string | null }
): PayrollLinkCandidate {
  return {
    movement_id: movementId,
    account_id: checkingAccountId(),
    account_label: "Corriente",
    received_on: receivedOn,
    amount_clp: amountClp,
    amount_usd: null,
    description: opts?.description ?? "0001234567 REMUNERACION    EJEMPLOSOFT",
    cartola_note: opts?.cartola_note ?? null,
    source: "checking",
    native_amount: amountClp,
    native_currency: "clp",
  };
}

function usdCandidate(movementId: number, receivedOn: string, amountUsd: number): PayrollLinkCandidate {
  return {
    movement_id: movementId,
    account_id: 1,
    account_label: "US checking",
    received_on: receivedOn,
    amount_clp: Math.round(amountUsd * 950),
    amount_usd: amountUsd,
    description: "DIRECT DEP EXAMPLECO PAYROLL",
    cartola_note: null,
    source: "checking",
    native_amount: amountUsd,
    native_currency: "usd",
  };
}

describe("findUsPayrollAutoLinkMovement", () => {
  it("pairs two stubs of one month with their own deposits, to the cent", () => {
    const candidates = [usdCandidate(301, "2099-03-06", 3_210.45), usdCandidate(302, "2099-03-20", 3_210.45), usdCandidate(303, "2099-03-20", 3_210.44)];
    const taken = new Set<number>();
    const first = findUsPayrollAutoLinkMovement(3_210.45, "2099-03-06", candidates, taken);
    expect(first).toEqual({ kind: "linked", movement_id: 301 });
    taken.add(301);
    expect(findUsPayrollAutoLinkMovement(3_210.45, "2099-03-20", candidates, taken)).toEqual({ kind: "linked", movement_id: 302 });
  });

  it("ignores peso credits and credits outside the window", () => {
    const peso = { ...usdCandidate(311, "2099-03-06", 3_210.45), native_currency: "clp" };
    const late = usdCandidate(312, "2099-03-12", 3_210.45);
    expect(findUsPayrollAutoLinkMovement(3_210.45, "2099-03-06", [peso, late], new Set())).toEqual({ kind: "unmatched" });
  });

  it("reports two deposits equally near the pay date", () => {
    const a = usdCandidate(321, "2099-03-05", 100);
    const b = usdCandidate(322, "2099-03-07", 100);
    expect(findUsPayrollAutoLinkMovement(100, "2099-03-06", [a, b], new Set())).toEqual({ kind: "ambiguous", movement_ids: [321, 322] });
  });
});

describe("payrollWorkEarningsLinking", () => {
  it("links liquido within REMUNERACION tolerance", () => {
    const movementId = insertRemuneracionCredit("2099-05-30", 3_062_609, 991001);
    const candidates = [asCandidate(movementId, "2099-05-30", 3_062_609)];
    const result = findPayrollAutoLinkMovement(
      3_062_633,
      "2099-05",
      "EJEMPLOSOFT LLC",
      candidates,
      new Set()
    );
    expect(result).toEqual({ kind: "linked", movement_id: movementId });
    expect(PAYROLL_LINK_REMUNERACION_TOLERANCE_CLP).toBeGreaterThanOrEqual(24);
    db.prepare(`DELETE FROM movements WHERE id = ?`).run(movementId);
  });

  it("links Dealsyte vista transfer via employer token with tolerance", () => {
    const candidates = [
      asCandidate(201, "2019-07-01", 2_100_000, {
        description: "Transf. DEMOTECH CH",
        cartola_note:
          "import:cartola|2019-07|G.Finanzas|Transf. DEMOTECH CH|on:2019-07-01|amt:2100000",
      }),
    ];
    const result = findPayrollAutoLinkMovement(
      2_100_000,
      "2019-06",
      "DEMOTECH CHILE SPA",
      candidates,
      new Set()
    );
    expect(result).toEqual({ kind: "linked", movement_id: 201 });
  });

  it("prefers deposit in month after period_month over same-month candidate", () => {
    const sameMonth = asCandidate(101, "2019-04-30", 2_122_917, {
      description: "REMUNERACION",
      cartola_note: "REMUNERACION",
    });
    const nextMonth = asCandidate(102, "2019-05-02", 2_122_917, {
      description: "REMUNERACION",
      cartola_note: "REMUNERACION",
    });
    const result = findPayrollAutoLinkMovement(
      2_122_917,
      "2019-04",
      "DEMOTECH CHILE SPA",
      [sameMonth, nextMonth],
      new Set()
    );
    expect(result).toEqual({ kind: "linked", movement_id: 102 });
  });

  it("breaks ties by lower movement_id when scores match", () => {
    const a = asCandidate(101, "2099-05-30", 3_000_000);
    const b = asCandidate(102, "2099-05-30", 3_000_000);
    const result = findPayrollAutoLinkMovement(
      3_000_000,
      "2099-05",
      "EJEMPLOSOFT LLC",
      [a, b],
      new Set()
    );
    expect(result).toEqual({ kind: "linked", movement_id: 101 });
  });
});

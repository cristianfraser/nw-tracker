import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { db } from "./db.js";
import {
  getPayrollWorkEarningById,
  incomeKindByMovementId,
  loadPayrollWorkEarnings,
  payrollPeriodByMovementIdRecord,
  updatePayrollWorkEarning,
} from "./flowsPayrollWorkEarnings.js";

const EMPLOYER = "vitest-payroll-employer";
const PDF_CLP = "vitest-payroll-clp.pdf";
const PDF_USD = "vitest-payroll-usd.pdf";
const PDF_BROKEN_USD = "vitest-payroll-usd-broken.pdf";
const ACCOUNT_NAME = "vitest-payroll-account";
const MOVEMENT_NOTE = "vitest-payroll-movement";

let accountId = 0;
let movementId = 0;
let otherMovementId = 0;
let clpRowId = 0;
let usdRowId = 0;

function insertEarning(v: {
  period_month: string;
  liquido: number;
  liquido_currency: "clp" | "usd";
  source_pdf: string;
  total_haberes_clp?: number | null;
  total_descuentos_clp?: number | null;
  movement_id?: number | null;
  link_source?: "auto" | "manual" | null;
}): number {
  return Number(
    db
      .prepare(
        `INSERT INTO payroll_work_earnings
           (period_month, employer_name, earning_type, total_haberes_clp, total_descuentos_clp,
            liquido, liquido_currency, source_pdf, movement_id, link_source)
         VALUES (?, ?, 'salary', ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        v.period_month,
        EMPLOYER,
        v.total_haberes_clp ?? null,
        v.total_descuentos_clp ?? null,
        v.liquido,
        v.liquido_currency,
        v.source_pdf,
        v.movement_id ?? null,
        v.link_source ?? null
      ).lastInsertRowid
  );
}

function cleanup(): void {
  db.prepare(`DELETE FROM payroll_work_earnings WHERE employer_name = ?`).run(EMPLOYER);
  db.prepare(`DELETE FROM movements WHERE note = ?`).run(MOVEMENT_NOTE);
  db.prepare(`DELETE FROM accounts WHERE name = ?`).run(ACCOUNT_NAME);
}

beforeAll(() => {
  cleanup();
  const leaf = db.prepare(`SELECT id FROM asset_groups LIMIT 1`).get() as { id: number };
  accountId = Number(
    db.prepare(`INSERT INTO accounts (asset_group_id, name) VALUES (?, ?)`).run(leaf.id, ACCOUNT_NAME)
      .lastInsertRowid
  );
  const insMovement = db.prepare(
    `INSERT INTO movements (account_id, amount_clp, occurred_on, note) VALUES (?, ?, ?, ?)`
  );
  movementId = Number(insMovement.run(accountId, 1_500_000, "2031-02-05", MOVEMENT_NOTE).lastInsertRowid);
  otherMovementId = Number(
    insMovement.run(accountId, 3_500_000, "2031-01-07", MOVEMENT_NOTE).lastInsertRowid
  );

  clpRowId = insertEarning({
    period_month: "2031-01",
    liquido: 1_500_000.6,
    liquido_currency: "clp",
    source_pdf: PDF_CLP,
    total_haberes_clp: 1_900_000,
    total_descuentos_clp: 400_000,
    movement_id: movementId,
    link_source: "auto",
  });
  usdRowId = insertEarning({
    period_month: "2031-02",
    liquido: 4450,
    liquido_currency: "usd",
    source_pdf: PDF_USD,
    total_haberes_clp: 3_560_000,
    total_descuentos_clp: 60_000,
  });
});

afterAll(() => cleanup());

describe("loadPayrollWorkEarnings", () => {
  it("maps a clp líquido to liquido_clp (rounded) with no USD leg", () => {
    const row = getPayrollWorkEarningById(clpRowId)!;
    expect(row.liquido_clp).toBe(1_500_001);
    expect(row.liquido_usd).toBeNull();
  });

  it("derives the CLP equivalent of a usd líquido as haberes − descuentos", () => {
    const row = getPayrollWorkEarningById(usdRowId)!;
    expect(row.liquido_usd).toBe(4450);
    expect(row.liquido_clp).toBe(3_500_000);
  });

  it("throws for a usd líquido without the CLP breakdown", () => {
    const id = insertEarning({
      period_month: "2031-03",
      liquido: 4000,
      liquido_currency: "usd",
      source_pdf: PDF_BROKEN_USD,
    });
    try {
      expect(() => loadPayrollWorkEarnings()).toThrow(/usd líquido without CLP haberes\/descuentos/);
    } finally {
      db.prepare(`DELETE FROM payroll_work_earnings WHERE id = ?`).run(id);
    }
  });

  it("joins the linked movement (date, rounded CLP, account label)", () => {
    const row = getPayrollWorkEarningById(clpRowId)!;
    expect(row.movement_id).toBe(movementId);
    expect(row.linked_received_on).toBe("2031-02-05");
    expect(row.linked_amount_clp).toBe(1_500_000);
    expect(row.linked_account_label).toBe(ACCOUNT_NAME);
  });

  it("orders rows by period_month descending", () => {
    const rows = loadPayrollWorkEarnings().filter((r) => r.employer_name === EMPLOYER);
    expect(rows.map((r) => r.period_month)).toEqual(["2031-02", "2031-01"]);
  });
});

describe("movement-id lookups", () => {
  it("exposes earning type and period by movement id", () => {
    expect(incomeKindByMovementId().get(movementId)).toBe("salary");
    expect(payrollPeriodByMovementIdRecord()[movementId]).toBe("2031-01");
  });
});

describe("updatePayrollWorkEarning", () => {
  it("changes earning_type", () => {
    const row = updatePayrollWorkEarning(usdRowId, { earning_type: "severance" });
    expect(row.earning_type).toBe("severance");
    updatePayrollWorkEarning(usdRowId, { earning_type: "salary" });
  });

  it("links a movement as manual and unlinks back to null", () => {
    const linked = updatePayrollWorkEarning(usdRowId, { movement_id: otherMovementId });
    expect(linked.movement_id).toBe(otherMovementId);
    expect(linked.link_source).toBe("manual");
    expect(linked.linked_amount_clp).toBe(3_500_000);

    const unlinked = updatePayrollWorkEarning(usdRowId, { movement_id: null });
    expect(unlinked.movement_id).toBeNull();
    expect(unlinked.link_source).toBeNull();
    expect(unlinked.linked_received_on).toBeNull();
  });

  it("rejects linking a movement already claimed by another earning", () => {
    expect(() => updatePayrollWorkEarning(usdRowId, { movement_id: movementId })).toThrow(
      /already linked to payroll work earning/
    );
  });

  it("returns the row unchanged for an empty patch", () => {
    const before = getPayrollWorkEarningById(clpRowId)!;
    const after = updatePayrollWorkEarning(clpRowId, {});
    expect(after).toEqual(before);
  });

  it("throws for an unknown id", () => {
    expect(() => updatePayrollWorkEarning(999_999_999, {})).toThrow(/not found/);
  });
});

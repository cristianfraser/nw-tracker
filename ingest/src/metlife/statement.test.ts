import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { describeLenderStatementResult, loadMetlifeCaptureDir } from "./read.js";
import { metlifeApiName, metlifeReadAt, metlifeStatementPayload, type MetlifeApiCall, type MetlifeApiName } from "./statement.js";

/**
 * A synthetic «Centro de pago» reading, in the portal's own shapes (invented credit and amounts):
 * cuota 13 due 2031-04-10 at a UF of 40.000 (10 UF = 400.000: 250.000 amortization + 140.000
 * interest + 0,25 UF of insurance), cuota 12 paid 2031-03-11 (395.000 in parts).
 */
const API = "https://latam.apis.metlife.com/external/pip/channel/v1/tenants/api";
const CREDIT = "TEST0000A001";

function fixture(): Record<MetlifeApiName, MetlifeApiCall> {
  return {
    credits: {
      url: `${API}/credits?poliza=${CREDIT}`,
      status: 200,
      requestBody: null,
      receivedAt: "2031-04-01T12:00:01.000Z",
      responseBody: {
        creditInformation: {
          outstandingBalanceUf: 1500.1234,
          totalMortgageNumber: 240,
          lastPaidMortgageNumber: 12,
          originalDebtUf: 1600,
          minimunFeePesos: 400000,
          maximumFeePesos: 480000,
          lastPaidMortgageValuePesos: 395000,
          lastPaymentDate: "2031-03-11",
          creditGrantingDate: "2030-03-01",
        },
        debtors: [{ rut: "11111111-1", name: "TEST DEBTOR", type: "titular" }],
      },
    },
    pending: {
      url: `${API}/payments/pending?mortgage=true&insuranceLife=true`,
      status: 200,
      requestBody: null,
      receivedAt: "2031-04-01T12:00:02.000Z",
      responseBody: {
        item: [
          {
            idProduct: CREDIT,
            nameProduct: "FLEXIBLE",
            type: "credit",
            totalMortgageNumber: 240,
            availablePayments: [
              {
                status: "por vencer",
                period: "203104",
                dueDate: "2031-04-10",
                feePesos: 400000,
                feeUf: 10,
                totalFeePesos: 400000,
                totalFeeUf: 10,
                mortgageNumber: 13,
                mortgageInformation: { amortization: 250000, paidInterest: 140000, defaultInterest: 0, collectionFee: 0, total: 390000 },
                minimunFeePesos: 400000,
                minimunFeeUf: 10,
                maximumFeePesos: 480000,
                maximumFeeUf: 12,
              },
            ],
          },
        ],
        metadata: {},
      },
    },
    history: {
      url: `${API}/payments/history`,
      status: 200,
      requestBody: { products: [CREDIT], status: ["PAGADO", "PENDIENTE", "VENCIDO"] },
      receivedAt: "2031-04-01T12:00:03.000Z",
      responseBody: {
        items: [
          {
            mortgageNumber: 13,
            dueDate: "10-04-2031",
            paymentDate: null,
            status: "PENDIENTE",
            amortizationPesos: 250000,
            extAmortizationPesos: 0,
            interestPesos: 140000,
            faultInterestPesos: 0,
            collectionExpenses: 0,
            totalMortgageAmmountPesos: 400000,
            insurances: { fireInsuranceUf: 0.1, lifeInsuranceUf: 0.15, otherInsuranceUf: 0, fireInsurancePesos: null, lifeInsurancePesos: null, otherInsurancePesos: null, totalInsurancePesos: null, totalInsuranceUf: 0.25 },
          },
          {
            mortgageNumber: 12,
            dueDate: "10-03-2031",
            paymentDate: "11-03-2031",
            status: "PAGADO",
            amortizationPesos: 240000,
            extAmortizationPesos: 0,
            interestPesos: 145000,
            faultInterestPesos: 0,
            collectionExpenses: 0,
            totalMortgageAmmountPesos: 395000,
            insurances: { fireInsuranceUf: 0.1, lifeInsuranceUf: 0.15, otherInsuranceUf: 0, fireInsurancePesos: 4000, lifeInsurancePesos: 6000, otherInsurancePesos: null, totalInsurancePesos: 10000, totalInsuranceUf: 0.25 },
          },
        ],
        metadata: { limit: 50, offset: 1, totalCount: 2 },
      },
    },
  };
}

/** A deep copy with `edit` applied to one answer's body. */
function edited(name: MetlifeApiName, edit: (body: any) => void): Record<MetlifeApiName, MetlifeApiCall> {
  const calls = structuredClone(fixture());
  edit(calls[name].responseBody);
  return calls;
}

describe("metlifeApiName", () => {
  it("names the three answers and nothing else", () => {
    expect(metlifeApiName(`${API}/credits?poliza=X`)).toBe("credits");
    expect(metlifeApiName(`${API}/payments/pending?mortgage=true&insuranceLife=X`)).toBe("pending");
    expect(metlifeApiName(`${API}/payments/pending?mortgage=false`)).toBeNull();
    expect(metlifeApiName(`${API}/payments/history`)).toBe("history");
    expect(metlifeApiName(`${API}/payments`)).toBeNull();
    expect(metlifeApiName("https://portaldeclientes.metlife.cl/tenants/api/credits")).toBeNull();
  });
});

describe("metlifeStatementPayload", () => {
  it("maps the portal's answers to the contract", () => {
    const calls = fixture();
    const p = metlifeStatementPayload(calls, metlifeReadAt(calls));
    expect(p.read_at).toBe("2031-04-01T12:00:03.000Z");
    expect(p.credit_number).toBe(CREDIT);
    expect(p.credit).toEqual({ balance_uf: 1500.1234, original_debt_uf: 1600, total_cuotas: 240, last_paid_cuota: 12, last_paid_on: "2031-03-11", last_paid_pesos: 395000 });
    expect(p.pending).toEqual([
      {
        cuota: 13,
        period: "203104",
        due_on: "2031-04-10",
        fee_uf: 10,
        fee_pesos: 400000,
        min_uf: 10,
        min_pesos: 400000,
        max_uf: 12,
        max_pesos: 480000,
        amortization_pesos: 250000,
        interest_pesos: 140000,
        default_interest_pesos: 0,
        collection_fee_pesos: 0,
      },
    ]);
    expect(p.history.map((h) => [h.cuota, h.status, h.due_on, h.paid_on])).toEqual([
      [13, "pending", "2031-04-10", null],
      [12, "paid", "2031-03-10", "2031-03-11"],
    ]);
    expect(p.history[1]!.insurance).toEqual({ fire_uf: 0.1, life_uf: 0.15, other_uf: 0, fire_pesos: 4000, life_pesos: 6000, other_pesos: null });
  });

  it("refuses what it cannot read for sure", () => {
    const at = "2031-04-01T12:00:03.000Z";
    expect(() => metlifeStatementPayload(edited("history", (b) => (b.items[1].status = "ANULADO")), at)).toThrow(/unknown status "ANULADO"/);
    expect(() => metlifeStatementPayload(edited("pending", (b) => (b.item[0].availablePayments[0].status = "vencido")), at)).toThrow(/unknown status/);
    expect(() => metlifeStatementPayload(edited("history", (b) => (b.items[1].paymentDate = "31-02-2031")), at)).toThrow(/expected dd-mm-yyyy/);
    expect(() => metlifeStatementPayload(edited("credits", (b) => (b.creditInformation.lastPaymentDate = "11/03/2031")), at)).toThrow(/expected YYYY-MM-DD/);
    expect(() => metlifeStatementPayload(edited("credits", (b) => delete b.creditInformation.outstandingBalanceUf), at)).toThrow(/outstandingBalanceUf: expected a number/);
    expect(() => metlifeStatementPayload(edited("pending", (b) => b.item.push(b.item[0])), at)).toThrow(/expected one credit/);
    expect(() => metlifeStatementPayload(edited("history", (b) => (b.metadata.totalCount = 9)), at)).toThrow(/holds 2 of 9/);
    // The parts of a paid cuota must add up (the contract's check).
    expect(() => metlifeStatementPayload(edited("history", (b) => (b.items[1].interestPesos = 100)), at)).toThrow(/add up/);
    const other = fixture();
    other.credits.url = `${API}/credits?poliza=OTHER`;
    expect(() => metlifeStatementPayload(other, at)).toThrow(/another credit/);
    const failed = fixture();
    failed.history.status = 502;
    expect(() => metlifeStatementPayload(failed, at)).toThrow(/answered 502/);
  });
});

describe("loadMetlifeCaptureDir", () => {
  it("takes the last good answer of each in a capture directory", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nw-metlife-"));
    try {
      const calls = fixture();
      const write = (name: string, data: unknown) => fs.writeFileSync(path.join(dir, name), JSON.stringify(data));
      write("001-token.json", { url: "https://federate.sso.metlife.com/as/token.oauth2", status: 200, responseBody: {} });
      write("040-pending.json", { ...calls.pending, responseBody: { item: [] } });
      write("055-credits.json", calls.credits);
      write("056-pending.json", calls.pending);
      write("057-history.json", calls.history);
      write("071-pending.json", { ...calls.pending, status: 500 });
      write("p001-load.json", { at: "x", frames: [] });
      const loaded = loadMetlifeCaptureDir(dir);
      expect(loaded.pending).toEqual(calls.pending);
      expect(metlifeStatementPayload(loaded, metlifeReadAt(loaded)).pending).toHaveLength(1);
      fs.rmSync(path.join(dir, "057-history.json"));
      expect(() => loadMetlifeCaptureDir(dir)).toThrow(/no history answer/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("describeLenderStatementResult", () => {
  it("prints the quote and the paid cuotas and counts what was written", () => {
    const out = describeLenderStatementResult({
      status: "applied",
      kind: "mortgage.lender_statement",
      schema_version: 1,
      retry: false,
      dry_run: false,
      details: {
        quote: { cuota: 13, due_on: "2031-04-10", stored: true, first_seen_at: "2031-04-01T12:00:03.000Z" },
        paid: [
          { cuota: 12, outcome: "written", detail: "movements 1 / 2" },
          { cuota: 11, outcome: "matches", detail: "" },
        ],
      },
    });
    expect(out).toMatchObject({ written: 1, quoteStored: true });
    expect(out.lines).toEqual([
      "server: applied",
      "  quote: cuota 13 due 2031-04-10 — stored",
      "  cuota 12: written — movements 1 / 2",
      "  cuota 11: matches",
      "  paid cuotas: 1 written, 1 matching, 0 waiting",
    ]);
  });
});

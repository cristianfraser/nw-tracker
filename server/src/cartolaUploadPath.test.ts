import { beforeEach, describe, expect, it, vi } from "vitest";
import type { BankAccountStatementsPayload } from "nw-tracker-contracts";

/** The payloads the one cartola path received, and what it answers. */
const applied: BankAccountStatementsPayload[] = [];

const PAYLOAD: BankAccountStatementsPayload = {
  account: { issuer: "santander", product: "checking" },
  force_reimport: false,
  statements: [
    {
      document: "cartola-2031-03.xlsx",
      period_month: "2031-03",
      period_from: "2031-03-01",
      period_to: "2031-03-31",
      opening_balance: 1000,
      closing_balance: 900,
      month_closing_balances: null,
      movements: [{ date: "2031-03-05", branch: "", description: "COMPRA", document_no: "1", amount: -100 }],
      skipped_rows: [],
      notes: [],
    },
  ],
  unreadable: [],
};

vi.mock("./ingestFeeder.js", () => ({
  requestFeederParse: async () => ({
    status: "parsed",
    result: { kind: "bank_account.statements", schema_version: 2, payload: PAYLOAD },
  }),
}));
vi.mock("./bankAccountStatementsApply.js", () => ({
  applyBankAccountStatements: (payload: BankAccountStatementsPayload) => {
    applied.push(payload);
    return {
      account_id: 1,
      files: [{ file: "cartola-2031-03.xlsx", period_month: "2031-03", status: "imported", movements_parsed: 1, movements_imported: 1, error: null }],
      report: [],
    };
  },
}));
vi.mock("./checkingCartolaImport.js", async (orig) => ({
  ...(await orig<typeof import("./checkingCartolaImport.js")>()),
  checkingAccountId: () => 1,
}));
vi.mock("./importBatches.js", () => ({ createImportBatch: () => 99 }));

const { importCheckingCartolaXlsx } = await import("./accountImports.js");

describe("a cartola upload takes the one cartola path", () => {
  beforeEach(() => {
    applied.length = 0;
  });

  it("applies the parsed statements as the ingest kind does", async () => {
    const result = await importCheckingCartolaXlsx(1, Buffer.from("x"), "cartola-2031-03.xlsx");
    expect(applied).toEqual([PAYLOAD]);
    expect(result).toMatchObject({ batch_id: 99, period_month: "2031-03", inserted: 1, already_imported_month: false });
  });

  it("re-imports the period only when asked for that period", async () => {
    await importCheckingCartolaXlsx(1, Buffer.from("x"), "cartola-2031-03.xlsx", { replaceMonth: "2031-02" });
    await importCheckingCartolaXlsx(1, Buffer.from("x"), "cartola-2031-03.xlsx", { replaceMonth: "2031-03" });
    expect(applied.map((p) => p.force_reimport)).toEqual([false, true]);
  });
});

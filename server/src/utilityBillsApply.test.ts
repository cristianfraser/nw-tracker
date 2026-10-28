import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { UtilityBill } from "nw-tracker-contracts";
import { db } from "./db.js";
import type { FlowCcExpenseLineRow } from "./flowsExpenses.js";
import { assignPurchaseToRealEstateExpense, loadGastosLinesForRealEstateMatching } from "./realEstateExpenseMatching.js";
import { getVitestSantanderCcMasterAccountId, wipeVitestCcFixtureData } from "./test/vitestDbSeed.js";
import {
  applyUtilityBills,
  normalizeServiceAccount,
  pickUtilityBillCharge,
  utilityBillMonth,
  utilityBillMonthsCovered,
} from "./utilityBillsApply.js";

const PLACE_SLUG = "vitest_utility_place";
const OTHER_PLACE_SLUG = "vitest_utility_other_place";
const SOURCE = "vitest-utility-bills.pdf";

function bill(over: Partial<UtilityBill> = {}): UtilityBill {
  return {
    provider: "enel",
    service: "electricity",
    service_account: "000123456-7",
    bill_number: `9${Math.floor(Math.random() * 1e9)}`,
    issued_on: "2036-10-05",
    amount: 38215,
    due_on: "2036-10-21",
    period_from: "2036-09-02",
    period_to: "2036-10-01",
    kwh: 175,
    m3: null,
    estimated_reading: false,
    message_id: `<${randomUUID()}@example.test>`,
    ...over,
  };
}

function ensurePlace(slug: string): number {
  db.prepare(`INSERT OR IGNORE INTO expense_groups (slug, label, sort_order) VALUES ('real_estate', 'Inmuebles', 0)`).run();
  const group = db.prepare(`SELECT id FROM expense_groups WHERE slug = 'real_estate'`).get() as { id: number };
  db.prepare(`INSERT OR IGNORE INTO expense_accounts (group_id, slug, label, sort_order) VALUES (?, ?, ?, 999)`).run(group.id, slug, slug);
  return (db.prepare(`SELECT id FROM expense_accounts WHERE group_id = ? AND slug = ?`).get(group.id, slug) as { id: number }).id;
}

/** A one-shot card line on the fixture master; returns its purchase key. */
function cardLine(merchant: string, ddmmyyyy: string, amount: number): string {
  const accountId = getVitestSantanderCcMasterAccountId()!;
  const stmt = db
    .prepare(
      `INSERT INTO cc_statements (account_id, card_group, source_pdf, statement_date, period_from, period_to, card_last4, layout, currency)
       VALUES (?, 'santander', ?, ?, '01/01/2036', ?, '0000', 'compact', 'clp')`
    )
    .run(accountId, `${SOURCE}-${randomUUID()}`, ddmmyyyy, ddmmyyyy);
  const parserRowId = `vitest-util-${randomUUID().replace(/-/g, "").slice(0, 12)}`;
  db.prepare(
    `INSERT INTO cc_statement_lines (statement_id, transaction_date, merchant, amount_clp, installment_flag, parser_row_id, dedupe_key)
     VALUES (?, ?, ?, ?, 0, ?, ?)`
  ).run(Number(stmt.lastInsertRowid), ddmmyyyy, merchant, amount, parserRowId, `vitest-util-dedupe-${parserRowId}`);
  const line = loadGastosLinesForRealEstateMatching().find((l) => l.merchant === merchant && l.amount_clp === amount);
  if (!line) throw new Error(`fixture line ${merchant} ${amount} is not a gastos line`);
  return line.purchase_key;
}

function map(provider: string, account: string, placeId: number): void {
  db.prepare(`INSERT OR REPLACE INTO utility_service_accounts (provider, service_account, expense_account_id) VALUES (?, ?, ?)`).run(provider, account, placeId);
}

function entry(id: number) {
  return db.prepare(`SELECT amount_clp, spent_on, category, kwh, m3, expense_account_id FROM expense_entries WHERE id = ?`).get(id) as {
    amount_clp: number;
    spent_on: string;
    category: string;
    kwh: number | null;
    m3: number | null;
    expense_account_id: number;
  };
}

const outcomeOf = (r: ReturnType<typeof applyUtilityBills>, b: UtilityBill) => {
  if (r.status === "conflict") throw new Error(r.message);
  return r.details.bills.find((x) => x.bill_number === b.bill_number);
};

let placeId = 0;
let otherPlaceId = 0;

beforeAll(() => {
  if (getVitestSantanderCcMasterAccountId() == null) throw new Error("vitest CC fixture master missing");
  placeId = ensurePlace(PLACE_SLUG);
  otherPlaceId = ensurePlace(OTHER_PLACE_SLUG);
});

afterAll(() => {
  db.prepare(`DELETE FROM utility_bills WHERE bill_number LIKE '9%' AND issued_on >= '2036-01-01'`).run();
  db.prepare(`DELETE FROM utility_service_accounts WHERE expense_account_id IN (?, ?)`).run(placeId, otherPlaceId);
  db.prepare(`DELETE FROM expense_entries WHERE expense_account_id IN (?, ?)`).run(placeId, otherPlaceId);
  db.prepare(`DELETE FROM expense_accounts WHERE id IN (?, ?)`).run(placeId, otherPlaceId);
  wipeVitestCcFixtureData();
});

describe("utilityBillMonth", () => {
  it("is the month the period's last half-month falls in", () => {
    expect(utilityBillMonth({ period_to: "2036-10-01", issued_on: "2036-10-05" })).toBe("2036-09");
    expect(utilityBillMonth({ period_to: "2036-11-04", issued_on: "2036-11-07" })).toBe("2036-10");
    // A two-month gas period closing on the 24th.
    expect(utilityBillMonth({ period_to: "2036-08-24", issued_on: "2036-08-28" })).toBe("2036-08");
    // No period printed: the issue day decides the same way.
    expect(utilityBillMonth({ period_to: null, issued_on: "2036-01-06" })).toBe("2035-12");
  });
});

describe("utilityBillMonthsCovered", () => {
  it("counts the months a printed period spans", () => {
    expect(utilityBillMonthsCovered({ period_from: "2036-06-26", period_to: "2036-08-23" })).toBe(2);
    expect(utilityBillMonthsCovered({ period_from: "2036-09-02", period_to: "2036-10-01" })).toBe(1);
    expect(utilityBillMonthsCovered({ period_from: null, period_to: null })).toBe(1);
  });
});

describe("normalizeServiceAccount", () => {
  it("compares account numbers without punctuation or leading zeros", () => {
    expect(normalizeServiceAccount("000123456-7")).toBe("1234567");
    expect(normalizeServiceAccount("123456-k")).toBe("123456K");
  });
});

describe("pickUtilityBillCharge", () => {
  const line = (over: Partial<FlowCcExpenseLineRow>): FlowCcExpenseLineRow =>
    ({ purchase_key: "k1", amount_clp: 38215, merchant: "ENEL DISTRIBUCION", merchant_key: "ENEL DISTRIBUCION", purchase_on: "2036-10-15", occurred_on: "2036-10-20", ...over }) as FlowCcExpenseLineRow;
  const b = bill();

  it("takes the one whole charge of the bill's pesos, merchant and window", () => {
    const pick = pickUtilityBillCharge(b, null, [line({}), line({ purchase_key: "k2", amount_clp: 41389 })], new Set());
    expect(pick).toMatchObject({ kind: "one", line: { purchase_key: "k1" } });
  });

  it("ignores another merchant, a charge before the bill and one past due + 20 days", () => {
    const lines = [
      line({ merchant: "METROGAS", merchant_key: "METROGAS" }),
      line({ purchase_key: "k2", purchase_on: "2036-10-04" }),
      line({ purchase_key: "k3", purchase_on: "2036-11-11" }),
    ];
    expect(pickUtilityBillCharge(b, null, lines, new Set())).toEqual({ kind: "none" });
    expect(pickUtilityBillCharge(b, null, [line({ purchase_on: "2036-11-10" })], new Set()).kind).toBe("one");
  });

  it("reports two fitting charges as ambiguous and skips taken ones", () => {
    const lines = [line({}), line({ purchase_key: "k2", purchase_on: "2036-10-16" })];
    expect(pickUtilityBillCharge(b, null, lines, new Set())).toEqual({ kind: "ambiguous", purchase_keys: ["k1", "k2"] });
    expect(pickUtilityBillCharge(b, null, lines, new Set(["k1"]))).toMatchObject({ kind: "one", line: { purchase_key: "k2" } });
  });
});

describe("applyUtilityBills", () => {
  it("reports an unmapped supply and writes nothing", () => {
    const b = bill({ service_account: "000999999-9" });
    const r = applyUtilityBills({ bills: [b] }, { todayYmd: "2036-10-10" });
    expect(r.status).toBe("applied");
    expect(outcomeOf(r, b)).toMatchObject({ outcome: "unmapped", expense_entry_id: null });
  });

  it("waits for its charge, then reports it overdue", () => {
    map("enel", "123456-7", placeId);
    const b = bill({ issued_on: "2036-03-05", due_on: "2036-03-20", period_to: "2036-03-02", amount: 11111 });
    expect(outcomeOf(applyUtilityBills({ bills: [b] }, { todayYmd: "2036-03-10" }), b)?.outcome).toBe("waiting");
    const again = applyUtilityBills({ bills: [b] }, { todayYmd: "2036-04-20" });
    expect(again.status).toBe("duplicate");
    expect(outcomeOf(again, b)?.outcome).toBe("overdue");
  });

  it("creates the bill row from its charge, with the kWh, in the bill's month", () => {
    map("enel", "123456-7", placeId);
    const key = cardLine("ENEL DISTRIBUCION CHILE", "15/10/2036", 38215);
    const b = bill();
    const r = applyUtilityBills({ bills: [b] }, { todayYmd: "2036-10-20" });
    const o = outcomeOf(r, b)!;
    expect(o).toMatchObject({ outcome: "created", purchase_key: key, place: PLACE_SLUG, bill_month: "2036-09" });
    expect(entry(o.expense_entry_id!)).toMatchObject({
      amount_clp: 38215,
      spent_on: "2036-09-30",
      category: "electricidad",
      kwh: 175,
      m3: null,
      expense_account_id: placeId,
    });
    expect(db.prepare(`SELECT purchase_key FROM real_estate_expense_links WHERE expense_entry_id = ?`).get(o.expense_entry_id)).toEqual({ purchase_key: key });

    // Settled: a resend changes nothing and follows nothing.
    const again = applyUtilityBills({ bills: [{ ...b, message_id: "<another-copy@example.test>" }] }, { todayYmd: "2036-10-21" });
    expect(again.status).toBe("duplicate");
    expect(outcomeOf(again, b)).toBeUndefined();
  });

  it("refuses a resend that states other content", () => {
    map("enel", "123456-7", placeId);
    const b = bill({ amount: 22222, issued_on: "2036-05-05", due_on: "2036-05-20", period_from: "2036-04-02", period_to: "2036-05-02" });
    applyUtilityBills({ bills: [b] }, { todayYmd: "2036-05-06" });
    const r = applyUtilityBills({ bills: [{ ...b, kwh: 999 }] }, { todayYmd: "2036-05-07" });
    expect(r).toMatchObject({ status: "conflict" });
    expect(applyUtilityBills({ bills: [{ ...b, period_to: "2036-05-03" }] }, { todayYmd: "2036-05-07" }).status).toBe("conflict");
    const stored = () =>
      db.prepare(`SELECT kwh, period_from, period_to FROM utility_bills WHERE provider = 'enel' AND bill_number = ?`).get(b.bill_number);
    expect(stored()).toEqual({ kwh: 175, period_from: "2036-04-02", period_to: "2036-05-02" });
  });

  it("takes a resend without the period, and fills a period the first send lacked", () => {
    map("enel", "123456-7", placeId);
    const b = bill({ amount: 22223, issued_on: "2036-05-05", due_on: "2036-05-20", period_from: null, period_to: null });
    applyUtilityBills({ bills: [b] }, { todayYmd: "2036-05-06" });
    const withPeriod = { ...b, period_from: "2036-04-02", period_to: "2036-05-02" };
    expect(applyUtilityBills({ bills: [withPeriod] }, { todayYmd: "2036-05-07" }).status).toBe("duplicate");
    expect(applyUtilityBills({ bills: [b] }, { todayYmd: "2036-05-07" }).status).toBe("duplicate");
    expect(db.prepare(`SELECT period_from, period_to FROM utility_bills WHERE provider = 'enel' AND bill_number = ?`).get(b.bill_number)).toEqual({
      period_from: "2036-04-02",
      period_to: "2036-05-02",
    });
  });

  it("leaves two fitting charges alone", () => {
    map("enel", "123456-7", placeId);
    cardLine("ENEL DISTRIBUCION CHILE", "10/06/2036", 33333);
    cardLine("ENEL DISTRIBUCION CHILE", "12/06/2036", 33333);
    const b = bill({ amount: 33333, issued_on: "2036-06-05", due_on: "2036-06-20", period_to: "2036-06-01" });
    const o = outcomeOf(applyUtilityBills({ bills: [b] }, { todayYmd: "2036-06-15" }), b)!;
    expect(o.outcome).toBe("ambiguous");
    expect(db.prepare(`SELECT COUNT(*) AS n FROM expense_entries WHERE expense_account_id = ? AND amount_clp = 33333`).get(placeId)).toEqual({ n: 0 });
  });

  it("takes the one of two fitting charges already filed under a bill (a bill paid twice)", () => {
    map("enel", "123456-7", placeId);
    const filed = cardLine("ENEL DISTRIBUCION CHILE", "10/06/2036", 34444);
    cardLine("ENEL DISTRIBUCION CHILE", "12/06/2036", 34444);
    const { expense_entry_id } = assignPurchaseToRealEstateExpense({
      purchaseKey: filed,
      accountSlug: PLACE_SLUG,
      kind: "electricidad",
      billMonth: "2036-05",
    });
    const b = bill({ amount: 34444, issued_on: "2036-06-05", due_on: "2036-06-20", period_to: "2036-06-01", kwh: 150 });
    const o = outcomeOf(applyUtilityBills({ bills: [b] }, { todayYmd: "2036-06-15" }), b)!;
    expect(o).toMatchObject({ outcome: "filled", expense_entry_id, purchase_key: filed });
  });

  it("fills the m³ on a gas bill filed by hand", () => {
    map("metrogas", "000441000001", placeId);
    const key = cardLine("METROGAS SA", "05/09/2036", 39870);
    const { expense_entry_id } = assignPurchaseToRealEstateExpense({ purchaseKey: key, accountSlug: PLACE_SLUG, kind: "gas", billMonth: "2036-08" });
    const b = bill({
      provider: "metrogas",
      service: "gas",
      service_account: "441000001",
      amount: 39870,
      issued_on: "2036-08-28",
      due_on: "2036-09-15",
      period_from: "2036-06-23",
      period_to: "2036-08-24",
      kwh: null,
      m3: 18.5,
      estimated_reading: null,
    });
    const o = outcomeOf(applyUtilityBills({ bills: [b] }, { todayYmd: "2036-09-06" }), b)!;
    expect(o).toMatchObject({ outcome: "filled", expense_entry_id, purchase_key: key });
    expect(entry(expense_entry_id)).toMatchObject({ m3: 18.5, kwh: null, category: "gas" });
  });

  it("never overwrites a different consumption or a bill row of another place", () => {
    map("enel", "123456-7", placeId);
    const keyA = cardLine("ENEL DISTRIBUCION CHILE", "14/07/2036", 44444);
    const a = assignPurchaseToRealEstateExpense({ purchaseKey: keyA, accountSlug: PLACE_SLUG, kind: "electricidad", billMonth: "2036-06", kwh: 100 });
    const billA = bill({ amount: 44444, issued_on: "2036-07-05", due_on: "2036-07-20", period_to: "2036-07-01", kwh: 150 });
    const oA = outcomeOf(applyUtilityBills({ bills: [billA] }, { todayYmd: "2036-07-15" }), billA)!;
    expect(oA.outcome).toBe("conflict");
    expect(entry(a.expense_entry_id).kwh).toBe(100);

    const keyB = cardLine("ENEL DISTRIBUCION CHILE", "14/08/2036", 55555);
    assignPurchaseToRealEstateExpense({ purchaseKey: keyB, accountSlug: OTHER_PLACE_SLUG, kind: "electricidad", billMonth: "2036-07" });
    const billB = bill({ amount: 55555, issued_on: "2036-08-05", due_on: "2036-08-20", period_to: "2036-08-01" });
    expect(outcomeOf(applyUtilityBills({ bills: [billB] }, { todayYmd: "2036-08-15" }), billB)?.outcome).toBe("conflict");
  });
});

describe("gastos comunes statements", () => {
  const PATTERN = "COMUNIDAD EDIFICIO EJEMPLO";
  const hoa = (over: Partial<UtilityBill> = {}): UtilityBill =>
    bill({
      provider: "comunidad_edificio",
      service: "hoa",
      service_account: "1203",
      bill_number: `1203-2036-${Math.floor(Math.random() * 1e6)}`,
      issued_on: "2036-10-08",
      due_on: "2036-10-13",
      period_from: "2036-09-01",
      period_to: "2036-09-30",
      amount: 64321,
      kwh: null,
      m3: null,
      estimated_reading: null,
      ...over,
    });
  const transfer = (over: Partial<FlowCcExpenseLineRow>): FlowCcExpenseLineRow =>
    ({
      purchase_key: "t1",
      amount_clp: 64321,
      merchant: `Transf a ${PATTERN}`,
      merchant_key: `TRANSF A ${PATTERN}`,
      purchase_on: "2036-10-28",
      occurred_on: "2036-10-28",
      ...over,
    }) as FlowCcExpenseLineRow;
  const counterparty = (direction: "out" | "own", name: string) => ({
    direction,
    name,
    rut: null,
    bank: null,
    account_type: null,
    account_number: null,
    email: null,
    comment: null,
    sent_at_chile: "2036-10-28 10:00",
  });

  it("takes a transfer to the building up to 35 days after the statement, never one between own accounts", () => {
    const b = hoa();
    expect(pickUtilityBillCharge(b, PATTERN, [transfer({})], new Set()).kind).toBe("one");
    expect(pickUtilityBillCharge(b, PATTERN, [transfer({ purchase_on: "2036-11-13" })], new Set()).kind).toBe("none");
    expect(pickUtilityBillCharge(b, PATTERN, [transfer({ transfer_counterparty: counterparty("own", PATTERN) })], new Set()).kind).toBe(
      "none"
    );
  });

  it("prefers the transfer whose mail names the building when two fit", () => {
    const lines = [
      transfer({}),
      transfer({ purchase_key: "t2", purchase_on: "2036-10-29", transfer_counterparty: counterparty("out", `${PATTERN} 100`) }),
    ];
    expect(pickUtilityBillCharge(hoa(), PATTERN, lines, new Set())).toMatchObject({ kind: "one", line: { purchase_key: "t2" } });
  });

  it("files the statement in its month and lists a later payment no statement accounts for", () => {
    db.prepare(`UPDATE expense_accounts SET comunidad_merchant_patterns = ? WHERE id = ?`).run(PATTERN, placeId);
    map("comunidad_edificio", "1203", placeId);
    const key = cardLine(`Transf a ${PATTERN}`, "27/10/2036", 64321);
    const b = hoa();
    const r = applyUtilityBills({ bills: [b] }, { todayYmd: "2036-10-30" });
    const o = outcomeOf(r, b)!;
    expect(o).toMatchObject({ outcome: "created", purchase_key: key, bill_month: "2036-09" });
    expect(entry(o.expense_entry_id!)).toMatchObject({ amount_clp: 64321, spent_on: "2036-09-30", category: "gastos_comunes", kwh: null, m3: null });

    // November's payment with no statement: listed once 10 days old, never filed.
    const unbilled = cardLine(`Transf a ${PATTERN}`, "26/11/2036", 61111);
    const early = applyUtilityBills({ bills: [] }, { todayYmd: "2036-12-01" });
    expect(early.status === "conflict" ? null : early.details.unbilled_hoa_payments).toEqual([]);
    const late = applyUtilityBills({ bills: [] }, { todayYmd: "2036-12-07" });
    expect(late.status === "conflict" ? null : late.details.unbilled_hoa_payments).toEqual([
      { place: PLACE_SLUG, purchase_key: unbilled, day: "2036-11-26", amount: 61111, merchant: `Transf a ${PATTERN}` },
    ]);
    expect(db.prepare(`SELECT COUNT(*) AS n FROM expense_entries WHERE expense_account_id = ? AND amount_clp = 61111`).get(placeId)).toEqual({ n: 0 });
  });
});

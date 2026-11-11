import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db } from "../db.js";
import { chileCalendarTodayYmd } from "../chileDate.js";
import { importCcStatementsWipeAndReload } from "../ccStatementsImport.js";
import { buildFlowsExpenseLines } from "../flowsExpenses.js";
import { parsedStatements } from "../test/parsedStatementRecords.js";
import { VITEST_SANTANDER_CC_MASTER_NOTES } from "../test/vitestDbSeed.js";
import { mergeFlowInto } from "./flowIdentity.js";

const PREFIX = "vitest-first-seen";

function fixtureAccountId(): number {
  const row = db.prepare(`SELECT id FROM accounts WHERE notes = ?`).get(VITEST_SANTANDER_CC_MASTER_NOTES) as
    | { id: number }
    | undefined;
  if (!row) throw new Error("vitest CC fixture master missing (vitestDbSeed)");
  return row.id;
}

function record(rowId: string, merchant = "VITEST FIRST SEEN", amountClp = 3100) {
  return {
    card_group: "santander",
    source_pdf: `${PREFIX}.pdf`,
    statement_date: "20/01/2025",
    period_from: "2024-12-21",
    period_to: "2025-01-20",
    card_last4: "",
    parser_layout: "compact",
    installment_flag: "false",
    amount_clp: String(amountClp),
    merchant,
    transaction_date: "02/01/2025",
    posting_date: "05/01/2025",
    row_id: rowId,
    dedupe_key: `${PREFIX}-${rowId}`,
    raw_line: `02/01/2025 ${merchant} $${amountClp}`,
    description_merged: merchant,
  };
}

function lines(accountId: number): { id: number; flow_id: number; parser_row_id: string }[] {
  return db
    .prepare(
      `SELECT l.id, l.flow_id, l.parser_row_id FROM cc_statement_lines l JOIN cc_statements s ON s.id = l.statement_id
       WHERE s.account_id = ? ORDER BY l.id`
    )
    .all(accountId) as { id: number; flow_id: number; parser_row_id: string }[];
}

function firstSeen(flowId: number): string | null {
  return (
    (db.prepare(`SELECT first_seen_on FROM flow_first_seen WHERE flow_id = ?`).get(flowId) as { first_seen_on: string } | undefined)
      ?.first_seen_on ?? null
  );
}

function setFirstSeen(flowId: number, day: string): void {
  db.prepare(`UPDATE flow_first_seen SET first_seen_on = ? WHERE flow_id = ?`).run(day, flowId);
}

function cleanup(accountId: number): void {
  db.prepare(`DELETE FROM cc_statement_lines WHERE statement_id IN (SELECT id FROM cc_statements WHERE account_id = ?)`).run(accountId);
  db.prepare(`DELETE FROM cc_statements WHERE account_id = ?`).run(accountId);
}

describe("flow_first_seen", () => {
  let accountId = 0;
  beforeAll(() => {
    accountId = fixtureAccountId();
    cleanup(accountId);
  });
  afterAll(() => cleanup(accountId));

  it("records today (Chile) for a newly inserted card line's flow", () => {
    importCcStatementsWipeAndReload(accountId, parsedStatements([record("a")]));
    const [line] = lines(accountId);
    expect(firstSeen(line!.flow_id)).toBe(chileCalendarTodayYmd());
  });

  it("a re-import that gives the line a new row keeps its earlier first-seen day", () => {
    importCcStatementsWipeAndReload(accountId, parsedStatements([record("a")]));
    setFirstSeen(lines(accountId)[0]!.flow_id, "2020-03-04");
    // Same printed line, a new parser row id (and a new line row; the bare flow goes with it).
    importCcStatementsWipeAndReload(accountId, parsedStatements([record("a2")]));
    const [line] = lines(accountId);
    expect(line!.parser_row_id).toBe("a2");
    expect(firstSeen(line!.flow_id)).toBe("2020-03-04");
  });

  it("a flow merge keeps the earlier day of the two", () => {
    importCcStatementsWipeAndReload(accountId, parsedStatements([record("m1", "VITEST FS ONE", 1000), record("m2", "VITEST FS TWO", 2000)]));
    const [one, two] = lines(accountId);
    setFirstSeen(one!.flow_id, "2021-06-01");
    setFirstSeen(two!.flow_id, "2019-01-15");
    mergeFlowInto(two!.flow_id, one!.flow_id, "to");
    expect(firstSeen(one!.flow_id)).toBe("2019-01-15");
    expect(firstSeen(two!.flow_id)).toBeNull();
    setFirstSeen(one!.flow_id, "2018-02-02");
    // The other direction: the surviving flow's earlier day stays.
    importCcStatementsWipeAndReload(accountId, parsedStatements([record("m1", "VITEST FS ONE", 1000), record("m3", "VITEST FS THREE", 3000)]));
    const [a, b] = lines(accountId);
    setFirstSeen(a!.flow_id, "2018-02-02");
    setFirstSeen(b!.flow_id, "2022-07-07");
    mergeFlowInto(b!.flow_id, a!.flow_id, "from");
    expect(firstSeen(a!.flow_id)).toBe("2018-02-02");
  });

  it("the expense line carries the posting day and the first-seen day", () => {
    importCcStatementsWipeAndReload(accountId, parsedStatements([record("e", "VITEST FS EXPENSE", 4100)]));
    const [line] = lines(accountId);
    setFirstSeen(line!.flow_id, "2025-01-09");
    const row = buildFlowsExpenseLines([accountId]).find((l) => l.source === "cc" && l.statement_line_id === line!.id);
    expect(row).toBeDefined();
    expect(row!.posting_on).toBe("2025-01-05");
    expect(row!.purchase_on).toBe("2025-01-02");
    expect(row!.first_seen_on).toBe("2025-01-09");
  });
});

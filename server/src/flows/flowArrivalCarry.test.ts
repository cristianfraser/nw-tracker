import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db } from "../db.js";
import { chileCalendarTodayYmd } from "../chileDate.js";
import { openWebPasteSourcePdf } from "../ccOpenWebPasteRepair.js";
import { replaceStatementLines } from "../cards/lineWrites.js";
import { statementKeysOf } from "../ccInstallmentLedgerMerge.js";
import { parsedStatements, type ParsedRecord } from "../test/parsedStatementRecords.js";
import { snapshotTables } from "../test/snapshotTables.js";
import { createTempCardMaster, deleteTempCardMaster } from "../test/tempCardMaster.js";
import { copyFlowFirstSeen, flowArrival, olderArrival, type FlowArrival } from "./flowFirstSeen.js";
import { convertStatementLineToInstallmentPurchase } from "../ccInstallmentManual.js";
import { mergeFlowInto } from "./flowIdentity.js";

const stamped = (on: string, at: string | null = null, seq: number | null = null): FlowArrival => ({
  kind: "stamped",
  stamp: { on, at, seq },
});
const BEFORE: FlowArrival = { kind: "before_stamps" };
const NOT_AN_ARRIVAL: FlowArrival = { kind: "not_an_arrival" };

describe("olderArrival (the carry rule)", () => {
  it("a flow on file before the stamps wins over any stamp, in either direction", () => {
    expect(olderArrival(BEFORE, stamped("2026-11-25"))).toEqual(BEFORE);
    expect(olderArrival(stamped("2026-11-25"), BEFORE)).toEqual(BEFORE);
    expect(olderArrival(BEFORE, NOT_AN_ARRIVAL)).toEqual(BEFORE);
  });

  it("keeps the earlier of two stamps, by day, then time, then order", () => {
    expect(olderArrival(stamped("2026-11-20"), stamped("2026-11-25"))).toEqual(stamped("2026-11-20"));
    const a = stamped("2026-11-25", "2026-11-25T03:00:00.000Z", 9);
    const b = stamped("2026-11-25", "2026-11-25T01:00:00.000Z", 12);
    expect(olderArrival(a, b)).toEqual(b);
    expect(olderArrival(stamped("2026-11-25", "x", 3), stamped("2026-11-25", "x", 2))).toEqual(stamped("2026-11-25", "x", 2));
  });

  it("a statement cuota line's flow changes nothing: a new row keeps its stamp", () => {
    expect(olderArrival(NOT_AN_ARRIVAL, stamped("2026-11-25"))).toEqual(stamped("2026-11-25"));
    expect(olderArrival(stamped("2026-11-25"), NOT_AN_ARRIVAL)).toEqual(stamped("2026-11-25"));
  });
});

const PREFIX = "VITEST ARRIVAL";
const restoreDerivedCardState = snapshotTables(["valuations", "cc_owed_anchors", "cc_billing_month_metrics"]);

function stampOf(flowId: number | null): { on: string; at: string | null; seq: number | null } | null {
  if (flowId == null) return null;
  return (
    (db
      .prepare(`SELECT first_seen_on AS "on", first_seen_at AS at, first_seen_seq AS seq FROM flow_first_seen WHERE flow_id = ?`)
      .get(flowId) as { on: string; at: string | null; seq: number | null } | undefined) ?? null
  );
}

function lineFlow(accountId: number, merchant: string): { id: number; flow_id: number; transaction_date: string } {
  const row = db
    .prepare(
      `SELECT l.id, l.flow_id, l.transaction_date FROM cc_statement_lines l JOIN cc_statements s ON s.id = l.statement_id
       WHERE s.account_id = ? AND l.merchant = ?`
    )
    .get(accountId, merchant) as { id: number; flow_id: number; transaction_date: string } | undefined;
  if (!row) throw new Error(`no line «${merchant}»`);
  return row;
}

describe("a card statement closing over its open bucket", () => {
  let accountId = 0;
  const OLD_STAMP = { on: "2026-05-12", at: "2026-05-12T15:00:00.000Z", seq: 1 };
  let oldUnstampedFlow = 0;
  let oldStampedFlow = 0;

  beforeAll(() => {
    accountId = createTempCardMaster({ issuer: "santander", last4: "5150", key: "vitest-arrival-carry" });
    // The open bucket of 2026-05, written before the statement: one line from before the stamps
    // (no stamp), one stamped when it was listed.
    const bucket = Number(
      db
        .prepare(
          `INSERT INTO cc_statements (account_id, card_group, source_pdf, statement_date, card_last4, layout, currency)
           VALUES (?, 'santander', ?, '20/05/2026', '5150', 'compact', 'clp')`
        )
        .run(accountId, openWebPasteSourcePdf("2026-05")).lastInsertRowid
    );
    const insertBucketLine = (day: string, merchant: string, amount: number) =>
      db
        .prepare(
          `INSERT INTO cc_statement_lines (statement_id, transaction_date, merchant, amount, currency, installment_flag, dedupe_key, parser_row_id, raw_line)
           VALUES (?, ?, ?, ?, 'clp', 0, ?, ?, 'raw')`
        )
        .run(bucket, day, merchant, amount, `vitest-arrival-${merchant}`, `web:vitest-arrival-${merchant}`);
    insertBucketLine("10/05/2026", `${PREFIX} GROCER`, 10_000);
    insertBucketLine("12/05/2026", `${PREFIX} SHOP`, 20_000);
    oldUnstampedFlow = lineFlow(accountId, `${PREFIX} GROCER`).flow_id;
    oldStampedFlow = lineFlow(accountId, `${PREFIX} SHOP`).flow_id;
    db.prepare(`INSERT INTO flow_first_seen (flow_id, first_seen_on, first_seen_at, first_seen_seq) VALUES (?, ?, ?, ?)`).run(
      oldStampedFlow,
      OLD_STAMP.on,
      OLD_STAMP.at,
      OLD_STAMP.seq
    );
    expect(stampOf(oldUnstampedFlow)).toBeNull();

    const base: ParsedRecord = {
      card_group: "santander",
      source_pdf: "vitest-arrival-2026-05-22.pdf",
      // The bank's close; the bucket carries the configured one (the 20th), as on file.
      statement_date: "22/05/2026",
      period_from: "23/04/2026",
      period_to: "22/05/2026",
      card_last4: "5150",
      parser_layout: "compact",
      installment_flag: "false",
    };
    const row = (id: string, day: string, merchant: string, amount: number, extra: ParsedRecord = {}): ParsedRecord => ({
      ...base,
      row_id: `vitest-arrival-${id}`,
      dedupe_key: `vitest-arrival-${id}`,
      transaction_date: day,
      merchant,
      amount_clp: String(amount),
      raw_line: `${day} ${merchant} ${amount}`,
      ...extra,
    });
    const statements = parsedStatements([
      // The grocer under the statement's own wording, a day later: the bucket settle pairs them
      // (`webPasteLineMatchesStatementLine`), identity pairing cannot.
      row("a", "11/05/26", `${PREFIX} GROCER, SANTIAGO`, 10_000),
      row("b", "12/05/26", `${PREFIX} SHOP`, 20_000),
      row("c", "13/05/26", `${PREFIX} NEW PURCHASE`, 30_000),
      row("d", "10/03/26", `${PREFIX} CUOTAS`, 6_000, {
        installment_flag: "true",
        nro_cuota_current: "2",
        nro_cuota_total: "6",
        valor_cuota_mensual_clp: "6000",
        monto_total_a_pagar_clp: "36000",
      }),
    ]);
    replaceStatementLines(accountId, statements, { replaceStatementKeys: statementKeysOf(statements) });
  });

  afterAll(() => {
    deleteTempCardMaster(accountId);
    restoreDerivedCardState();
  });

  it("an old unstamped bucket line settled by a statement line under another wording stays unstamped", () => {
    const settled = lineFlow(accountId, `${PREFIX} GROCER, SANTIAGO`);
    expect(db.prepare(`SELECT 1 FROM cc_statement_lines WHERE merchant = ?`).get(`${PREFIX} GROCER`)).toBeUndefined();
    expect(settled.flow_id).toBe(oldUnstampedFlow);
    expect(stampOf(settled.flow_id)).toBeNull();
  });

  it("a stamped bucket line keeps its own stamp", () => {
    expect(stampOf(lineFlow(accountId, `${PREFIX} SHOP`).flow_id)).toEqual(OLD_STAMP);
  });

  it("a statement line with no bucket twin is stamped now", () => {
    expect(stampOf(lineFlow(accountId, `${PREFIX} NEW PURCHASE`).flow_id)?.on).toBe(chileCalendarTodayYmd());
  });

  it("a statement's cuota line is not stamped", () => {
    expect(stampOf(lineFlow(accountId, `${PREFIX} CUOTAS`).flow_id)).toBeNull();
  });

  it("the plan the statement writes new is the cuota purchase's arrival", () => {
    const plan = db.prepare(`SELECT flow_id FROM cc_installment_purchases WHERE account_id = ?`).get(accountId) as { flow_id: number };
    expect(stampOf(plan.flow_id)?.on).toBe(chileCalendarTodayYmd());
  });

  it("stores every line day padded dd/mm/yyyy", () => {
    expect(lineFlow(accountId, `${PREFIX} NEW PURCHASE`).transaction_date).toBe("13/05/2026");
    expect(lineFlow(accountId, `${PREFIX} CUOTAS`).transaction_date).toBe("10/03/2026");
  });
});

describe("a statement close writing the plan of a cuota purchase first listed as a one-shot", () => {
  let accountId = 0;
  const OLD_STAMP = { on: "2026-05-06", at: "2026-05-06T15:00:00.000Z", seq: 2 };
  const planFlow = (merchant: string) =>
    (db.prepare(`SELECT flow_id FROM cc_installment_purchases WHERE account_id = ? AND merchant = ?`).get(accountId, merchant) as
      | { flow_id: number }
      | undefined)?.flow_id ?? null;

  beforeAll(() => {
    accountId = createTempCardMaster({ issuer: "santander", last4: "5152", key: "vitest-arrival-plans" });
    const bucket = Number(
      db
        .prepare(
          `INSERT INTO cc_statements (account_id, card_group, source_pdf, statement_date, card_last4, layout, currency)
           VALUES (?, 'santander', ?, '20/05/2026', '5152', 'compact', 'clp')`
        )
        .run(accountId, openWebPasteSourcePdf("2026-05")).lastInsertRowid
    );
    // The purchases as the listing showed them, at their full price: one from before the stamps,
    // one stamped when it was listed.
    for (const [merchant, day, total] of [
      [`${PREFIX} PLAN OLD`, "05/05/2026", 60_000],
      [`${PREFIX} PLAN LISTED`, "06/05/2026", 72_000],
    ] as const) {
      db.prepare(
        `INSERT INTO cc_statement_lines (statement_id, transaction_date, merchant, amount, currency, installment_flag, dedupe_key, parser_row_id, raw_line)
         VALUES (?, ?, ?, ?, 'clp', 0, ?, ?, 'raw')`
      ).run(bucket, day, merchant, total, `vitest-arrival-${merchant}`, `web:vitest-arrival-${merchant}`);
    }
    db.prepare(`INSERT INTO flow_first_seen (flow_id, first_seen_on, first_seen_at, first_seen_seq) VALUES (?, ?, ?, ?)`).run(
      lineFlow(accountId, `${PREFIX} PLAN LISTED`).flow_id,
      OLD_STAMP.on,
      OLD_STAMP.at,
      OLD_STAMP.seq
    );
    const cuota = (id: string, merchant: string, day: string, total: number): ParsedRecord => ({
      card_group: "santander",
      source_pdf: "vitest-arrival-plans-2026-05-22.pdf",
      statement_date: "22/05/2026",
      period_from: "23/04/2026",
      period_to: "22/05/2026",
      card_last4: "5152",
      parser_layout: "compact",
      row_id: `vitest-arrival-plans-${id}`,
      canonical_row_id: `vitest-arrival-plan-${id}`,
      dedupe_key: `vitest-arrival-plans-${id}`,
      transaction_date: day,
      merchant,
      amount_clp: String(total / 6),
      raw_line: `${day} ${merchant} ${total / 6}`,
      installment_flag: "true",
      nro_cuota_current: "1",
      nro_cuota_total: "6",
      valor_cuota_mensual_clp: String(total / 6),
      monto_total_a_pagar_clp: String(total),
    });
    const statements = parsedStatements([
      cuota("old", `${PREFIX} PLAN OLD`, "05/05/26", 60_000),
      cuota("listed", `${PREFIX} PLAN LISTED`, "06/05/26", 72_000),
      cuota("new", `${PREFIX} PLAN NEW`, "07/05/26", 84_000),
    ]);
    replaceStatementLines(accountId, statements, { replaceStatementKeys: statementKeysOf(statements) });
  });

  afterAll(() => {
    deleteTempCardMaster(accountId);
    restoreDerivedCardState();
  });

  it("the listed line goes, and the plan takes its arrival", () => {
    expect(db.prepare(`SELECT 1 FROM cc_statement_lines WHERE merchant = ? AND installment_flag = 0`).get(`${PREFIX} PLAN OLD`)).toBeUndefined();
    expect(stampOf(planFlow(`${PREFIX} PLAN OLD`))).toBeNull();
    expect(stampOf(planFlow(`${PREFIX} PLAN LISTED`))).toEqual(OLD_STAMP);
  });

  it("a plan with no line before it is stamped now", () => {
    expect(stampOf(planFlow(`${PREFIX} PLAN NEW`))?.on).toBe(chileCalendarTodayYmd());
  });
});

describe("carrying an arrival between two flows", () => {
  let accountId = 0;
  beforeAll(() => {
    accountId = createTempCardMaster({ issuer: "santander", last4: "5151", key: "vitest-arrival-merge" });
  });
  afterAll(() => deleteTempCardMaster(accountId));

  function flowOfNewLine(merchant: string): number {
    const st = Number(
      db
        .prepare(
          `INSERT INTO cc_statements (account_id, card_group, source_pdf, statement_date, card_last4, layout, currency)
           VALUES (?, 'santander', ?, '20/06/2026', '5151', 'compact', 'clp')`
        )
        .run(accountId, `vitest-arrival-merge-${merchant}.pdf`).lastInsertRowid
    );
    db.prepare(
      `INSERT INTO cc_statement_lines (statement_id, transaction_date, merchant, amount, currency, installment_flag, dedupe_key, raw_line)
       VALUES (?, '10/06/2026', ?, 1000, 'clp', 0, ?, 'raw')`
    ).run(st, merchant, `vitest-arrival-merge-${merchant}`);
    return lineFlow(accountId, merchant).flow_id;
  }
  const stamp = (flowId: number, on: string) =>
    db.prepare(`INSERT INTO flow_first_seen (flow_id, first_seen_on, first_seen_at, first_seen_seq) VALUES (?, ?, NULL, NULL)`).run(flowId, on);

  it("a merge into a flow on file before the stamps leaves it unstamped, whichever flow survives", () => {
    const old = flowOfNewLine(`${PREFIX} M OLD`);
    const fresh = flowOfNewLine(`${PREFIX} M NEW`);
    stamp(fresh, "2026-11-25");
    mergeFlowInto(fresh, old, "to");
    expect(stampOf(old)).toBeNull();

    const old2 = flowOfNewLine(`${PREFIX} M OLD2`);
    const fresh2 = flowOfNewLine(`${PREFIX} M NEW2`);
    stamp(fresh2, "2026-11-25");
    mergeFlowInto(old2, fresh2, "from");
    expect(stampOf(fresh2)).toBeNull();
  });

  it("a flow that records no row: a key's holder carries no arrival of its own, a retired flow is old", () => {
    const holder = Number(
      db
        .prepare(`INSERT INTO flows (kind, from_account_id, to_party_id, occurred_on, amount, currency) VALUES ('card_purchase', ?, 1, '2026-06-10', 1, 'clp')`)
        .run(accountId).lastInsertRowid
    );
    expect(flowArrival(holder)).toEqual({ kind: "not_an_arrival" });
    const fresh = flowOfNewLine(`${PREFIX} K NEW`);
    stamp(fresh, "2026-11-25");
    mergeFlowInto(fresh, holder, "to");
    expect(stampOf(holder)?.on).toBe("2026-11-25");
    db.prepare(`UPDATE flows SET retired_on = '2026-11-01' WHERE id = ?`).run(holder);
    db.prepare(`DELETE FROM cc_statement_lines WHERE merchant = ?`).run(`${PREFIX} K NEW`);
    db.prepare(`DELETE FROM flow_first_seen WHERE flow_id = ?`).run(holder);
    expect(flowArrival(holder)).toEqual({ kind: "before_stamps" });
  });

  it("a line converted to a plan gives the plan its arrival", () => {
    const line = (merchant: string) => {
      flowOfNewLine(merchant);
      return lineFlow(accountId, merchant).id;
    };
    const oldLine = line(`${PREFIX} V OLD`);
    const listed = line(`${PREFIX} V LISTED`);
    stamp(lineFlow(accountId, `${PREFIX} V LISTED`).flow_id, "2026-10-02");
    const planFlowOf = (id: number) =>
      (db.prepare(`SELECT flow_id FROM cc_installment_purchases WHERE id = ?`).get(id) as { flow_id: number }).flow_id;
    expect(stampOf(planFlowOf(convertStatementLineToInstallmentPurchase(accountId, oldLine, 3).id))).toBeNull();
    expect(stampOf(planFlowOf(convertStatementLineToInstallmentPurchase(accountId, listed, 3).id))?.on).toBe("2026-10-02");
  });

  it("a copy onto a new flow (a debit reshaped into a card payment) takes the replaced flow's arrival", () => {
    const debit = flowOfNewLine(`${PREFIX} C DEBIT`);
    const transfer = flowOfNewLine(`${PREFIX} C TRANSFER`);
    stamp(transfer, "2026-11-25");
    copyFlowFirstSeen(debit, transfer);
    expect(stampOf(transfer)).toBeNull();

    const debit2 = flowOfNewLine(`${PREFIX} C DEBIT2`);
    const transfer2 = flowOfNewLine(`${PREFIX} C TRANSFER2`);
    stamp(debit2, "2026-10-01");
    stamp(transfer2, "2026-11-25");
    copyFlowFirstSeen(debit2, transfer2);
    expect(stampOf(transfer2)?.on).toBe("2026-10-01");
    expect(stampOf(debit2)?.on).toBe("2026-10-01");
  });
});

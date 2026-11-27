import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parseServerConfig } from "./config.js";
import { db } from "./db.js";
import type { ImportSyncDocumentCell, ImportSyncDocumentCellState, ImportSyncDocumentCoveragePayload } from "./importSyncDocumentCoverage.js";
import type { ImportSyncDocumentAccount } from "./importSyncDocumentTypes.js";
import {
  LATE_DOCUMENT_TITLE,
  documentLateOn,
  lateDocumentMessage,
  lateDocuments,
  nextLateDocumentCheckAtMs,
  notifyLateDocuments,
} from "./lateDocuments.js";

type Payload = Pick<ImportSyncDocumentCoveragePayload, "months" | "accounts" | "cells">;

function cell(state: ImportSyncDocumentCellState): ImportSyncDocumentCell {
  return { imported: false, document: null, state };
}

const checking: ImportSyncDocumentAccount = { account_id: 1, label: "Cuenta corriente", document_kind: "checking_cartola" };
const vista: ImportSyncDocumentAccount = { account_id: 2, label: "Cuenta vista", document_kind: "cuenta_vista_cartola" };
const cardClp: ImportSyncDocumentAccount = { account_id: 3, label: "Card", document_kind: "cc_statement", cc_statement_currency: "clp" };
const cardUsd: ImportSyncDocumentAccount = { account_id: 3, label: "Card", document_kind: "cc_statement", cc_statement_currency: "usd" };
const singleCard: ImportSyncDocumentAccount = { account_id: 4, label: "Other card", document_kind: "cc_statement" };

/** One column, `states` newest first from `newestMonth`. */
function column(acc: ImportSyncDocumentAccount, months: string[], states: ImportSyncDocumentCellState[]): Payload {
  return { months, accounts: [acc], cells: states.map((s) => [cell(s)]) };
}

const lateMonths = (p: Payload, today: string) => lateDocuments(p, today).map((d) => `${d.month}@${d.late_on}`);

describe("documentLateOn", () => {
  it("puts a cartola on the 25th and a statement on the 7th of the following month, across the year", () => {
    expect(documentLateOn("checking_cartola", "2026-09")).toBe("2026-10-25");
    expect(documentLateOn("cuenta_vista_cartola", "2026-12")).toBe("2027-01-25");
    expect(documentLateOn("cc_statement", "2026-12")).toBe("2027-01-07");
  });
});

describe("lateDocuments", () => {
  const one = (acc: ImportSyncDocumentAccount, month: string) => column(acc, [month], ["missing"]);

  it("a missing cartola is late from the 25th, not the 24th", () => {
    expect(lateMonths(one(checking, "2026-09"), "2026-10-24")).toEqual([]);
    expect(lateMonths(one(checking, "2026-09"), "2026-10-25")).toEqual(["2026-09@2026-10-25"]);
    expect(lateMonths(one(vista, "2026-09"), "2026-10-25")).toEqual(["2026-09@2026-10-25"]);
  });

  it("a missing statement is late from the 7th, not the 6th, across the year end", () => {
    expect(lateMonths(one(singleCard, "2026-12"), "2027-01-06")).toEqual([]);
    expect(lateMonths(one(singleCard, "2026-12"), "2027-01-07")).toEqual(["2026-12@2027-01-07"]);
  });

  it("notifies only late days at most 60 days back", () => {
    // 2026-09 cartola late on 2026-10-25: day 60 after is 2026-12-24.
    expect(lateMonths(one(checking, "2026-09"), "2026-12-24")).toEqual(["2026-09@2026-10-25"]);
    expect(lateMonths(one(checking, "2026-09"), "2026-12-25")).toEqual([]);
  });

  it("only `missing` is ever late", () => {
    const states: ImportSyncDocumentCellState[] = ["not_due", "after_last", "before_first", "imported_no_file", "imported", "no_movements", "file_not_imported"];
    for (const s of states) expect(lateMonths(column(checking, ["2026-09"], [s]), "2026-11-01")).toEqual([]);
  });

  it("keys a card's CLP and USD columns apart, and a one-column card as pesos", () => {
    const payload: Payload = {
      months: ["2026-11", "2026-10"],
      accounts: [cardClp, cardUsd, singleCard],
      cells: [
        [cell("not_due"), cell("not_due"), cell("not_due")],
        [cell("missing"), cell("missing"), cell("imported")],
      ],
    };
    const late = lateDocuments(payload, "2026-11-27");
    expect(late.map(({ account_id, document_kind, currency, month }) => ({ account_id, document_kind, currency, month }))).toEqual([
      { account_id: 3, document_kind: "cc_statement", currency: "clp", month: "2026-10" },
      { account_id: 3, document_kind: "cc_statement", currency: "usd", month: "2026-10" },
    ]);
    expect(late.map(lateDocumentMessage)).toEqual([
      "Card: the 2026-10 statement has not arrived (expected by 2026-11-07).",
      "Card USD: the 2026-10 statement has not arrived (expected by 2026-11-07).",
    ]);
    const single = lateDocuments(column(singleCard, ["2026-10"], ["missing"]), "2026-11-27");
    expect(single[0]!.currency).toBe("clp");
  });
});

describe("nextLateDocumentCheckAtMs", () => {
  // 2026-11-27 is in Chile summer time (UTC−3): 09:00 Chile = 12:00 UTC.
  const slot27 = Date.parse("2026-11-27T12:00:00Z");
  const slot28 = Date.parse("2026-11-28T12:00:00Z");
  it("waits for today's slot, catches a missed one up once, then goes to tomorrow", () => {
    const before = slot27 - 3_600_000;
    expect(nextLateDocumentCheckAtMs({ nowMs: before, todayYmd: "2026-11-27", lastRunYmd: "2026-11-26", earliestMs: 0 })).toBe(slot27);
    const after = slot27 + 3_600_000;
    expect(nextLateDocumentCheckAtMs({ nowMs: after, todayYmd: "2026-11-27", lastRunYmd: null, earliestMs: after + 600_000 })).toBe(after + 600_000);
    expect(nextLateDocumentCheckAtMs({ nowMs: after, todayYmd: "2026-11-27", lastRunYmd: "2026-11-27", earliestMs: 0 })).toBe(slot28);
  });
});

describe("notifyLateDocuments", () => {
  const LABEL = "Vitest late-doc card";
  let accountId = 0;
  beforeAll(() => {
    const groupId = (db.prepare(`SELECT id FROM asset_groups WHERE slug = 'cash_eqs__cuenta_ahorro_vivienda'`).get() as { id: number }).id;
    accountId = Number(
      db.prepare(`INSERT INTO accounts (name, asset_group_id, import_key) VALUES (?, ?, 'vitest:late-documents')`).run(LABEL, groupId).lastInsertRowid
    );
  });
  afterAll(() => {
    db.prepare(`DELETE FROM late_document_notifications WHERE account_id = ?`).run(accountId);
    db.prepare(`DELETE FROM app_messages WHERE title = ? AND body LIKE ?`).run(LATE_DOCUMENT_TITLE, `${LABEL}%`);
    db.prepare(`DELETE FROM accounts WHERE id = ?`).run(accountId);
  });

  it("notifies a late pair once, however often the check runs", () => {
    const acc: ImportSyncDocumentAccount = { account_id: accountId, label: LABEL, document_kind: "cc_statement", cc_statement_currency: "usd" };
    const late = lateDocuments(column(acc, ["2026-10"], ["missing"]), "2026-11-27");
    expect(notifyLateDocuments(late)).toHaveLength(1);
    expect(notifyLateDocuments(late)).toHaveLength(0);
    const bodies = db
      .prepare(`SELECT body FROM app_messages WHERE kind = 'notification' AND title = ? AND body LIKE ?`)
      .all(LATE_DOCUMENT_TITLE, `${LABEL}%`) as { body: string }[];
    expect(bodies.map((b) => b.body)).toEqual([`${LABEL} USD: the 2026-10 statement has not arrived (expected by 2026-11-07).`]);
    expect(
      db.prepare(`SELECT document_kind, currency, month FROM late_document_notifications WHERE account_id = ?`).all(accountId)
    ).toEqual([{ document_kind: "cc_statement", currency: "usd", month: "2026-10" }]);
  });
});

describe("lateDocumentCheck flag", () => {
  it("is on by default, off with background jobs off, never on the demo", () => {
    expect(parseServerConfig({}).lateDocumentCheck).toBe(true);
    expect(parseServerConfig({ BACKGROUND_JOBS_ENABLED: "0" }).lateDocumentCheck).toBe(false);
    expect(parseServerConfig({ DEMO_MODE: "1", LATE_DOCUMENT_CHECK_ENABLED: "1" }).lateDocumentCheck).toBe(false);
  });
});

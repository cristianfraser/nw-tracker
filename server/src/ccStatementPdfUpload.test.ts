/**
 * The card page's PDF upload (`ccStatementPdfUpload.ts`) around the parse: the ingest service is
 * answered by a stubbed `fetch` (no service, no Python parser — the parser's own reading is
 * ingest's to test), the archive folder is a temp dir (`CFRASER_PDFS_DIR`). What is tested is the
 * server's part: which parsed statements the upload keeps (those its card master owns), the
 * failures it reports or throws, and the name each kept PDF is archived under.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EMPTY_CARD_STATEMENT_HEADER, type CardCanonicalLine, type CardCanonicalStatement } from "nw-tracker-contracts";
import { db } from "./db.js";
import { importCcStatementPdfsForAccount } from "./ccStatementPdfUpload.js";
import { createTempCardMaster, deleteTempCardMaster } from "./test/tempCardMaster.js";
import { snapshotTables } from "./test/snapshotTables.js";

const LAST4 = "9944";
const restoreDerived = snapshotTables(["valuations", "cc_owed_anchors", "cc_billing_month_metrics"]);

function purchase(iso: string, merchant: string, amount: number, id: string): CardCanonicalLine {
  return {
    kind: "card_purchase",
    transaction_date: iso,
    posting_date: null,
    printed_transaction_date: null,
    printed_posting_date: null,
    merchant,
    description: null,
    place: null,
    country: null,
    currency: "clp",
    amount,
    origin_amount: null,
    installment: null,
    origin_card_last4: null,
    cuota_purchase: null,
    document: { line_id: id, dedupe_key: id, section: "compact", raw_text: merchant, duplicate_across_statements: false, baseline_match: null },
  };
}

function statement(document: string, last4: string | null, lines: CardCanonicalLine[], periodTo: string | null = "24/09/2026"): CardCanonicalStatement {
  return {
    document,
    card_group: "santander",
    close: "24/09/2026",
    period_from: "25/08/2026",
    period_to: periodTo,
    pay_by: null,
    card_last4: last4,
    card_product: null,
    currency: "clp",
    layout: "compact",
    header: EMPTY_CARD_STATEMENT_HEADER,
    lines,
  };
}

/** The ingest service answers each file in turn: statements, or a 422 refusal. */
function stubParse(answers: ({ statements: CardCanonicalStatement[] } | { error: "unreadable" | "not_this_format"; message: string } | { kind: string })[]) {
  const queue = [...answers];
  const fetchStub = vi.fn(async () => {
    const a = queue.shift();
    if (!a) throw new Error("unexpected parse request");
    if ("error" in a) return new Response(JSON.stringify({ error: a.error, message: a.message }), { status: 422 });
    if ("kind" in a) return new Response(JSON.stringify({ kind: a.kind, schema_version: 1, payload: {} }), { status: 200 });
    return new Response(
      JSON.stringify({ kind: "card.statement", schema_version: 3, payload: { format: "canonical", full: false, statements: a.statements } }),
      { status: 200 }
    );
  });
  vi.stubGlobal("fetch", fetchStub);
  return fetchStub;
}

const pdf = (name: string) => ({ originalname: name, buffer: Buffer.from(`%PDF-vitest ${name}`) });

describe("importCcStatementPdfsForAccount", () => {
  let card = 0;
  let archive = "";
  const prevDir = process.env.CFRASER_PDFS_DIR;

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-26T15:00:00Z"));
    card = createTempCardMaster({ issuer: "santander", last4: LAST4, key: "vitest-pdf-upload" });
    archive = fs.mkdtempSync(path.join(os.tmpdir(), "vitest-cc-pdf-archive-"));
    process.env.CFRASER_PDFS_DIR = archive;
  });

  afterEach(() => {
    vi.useRealTimers();
    deleteTempCardMaster(card);
    restoreDerived();
    fs.rmSync(archive, { recursive: true, force: true });
    if (prevDir == null) delete process.env.CFRASER_PDFS_DIR;
    else process.env.CFRASER_PDFS_DIR = prevDir;
  });

  it("refuses an empty upload", async () => {
    await expect(importCcStatementPdfsForAccount(card, [])).rejects.toThrow(/At least one PDF file is required/);
  });

  it("throws when the ingest service does not answer, and on an answer of another kind", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Promise.reject(new Error("ECONNREFUSED"))));
    await expect(importCcStatementPdfsForAccount(card, [pdf("a.pdf")])).rejects.toThrow(/The PDF could not be read: .*ECONNREFUSED/);
    stubParse([{ kind: "store.receipt" }]);
    await expect(importCcStatementPdfsForAccount(card, [pdf("a.pdf")])).rejects.toThrow(/ingest answered store\.receipt v1, not card\.statement/);
  });

  it("throws the first refusal when no file parsed, naming the file (with .pdf added)", async () => {
    stubParse([
      { error: "unreadable", message: "no statement text" },
      { error: "not_this_format", message: "a cartola" },
    ]);
    await expect(importCcStatementPdfsForAccount(card, [pdf("scan"), pdf("other.pdf")])).rejects.toThrow(/^scan\.pdf: no statement text$/);
  });

  it("keeps only this card's statements and says which cards the others resolved to", async () => {
    stubParse([
      { statements: [statement("x 0001.pdf", "0001", [purchase("2026-09-03", "VITEST AJENO", 5_000, "vitest-up-1")])] },
      // This card's statement, but with no line: still nothing to import.
      { statements: [statement(`y ${LAST4}.pdf`, LAST4, [])] },
    ]);
    await expect(importCcStatementPdfsForAccount(card, [pdf("x.pdf"), pdf("y.pdf")])).rejects.toThrow(
      `No parsed rows matched this card account (account_id=${card}). Parsed card last4: [0001, ${LAST4}]; resolved to account ids: [${card}].`
    );
    expect(db.prepare(`SELECT COUNT(*) AS n FROM cc_statements WHERE account_id = ?`).get(card)).toEqual({ n: 0 });
  });

  it("imports this card's statement, archives it under its canonical name and renames source_pdf to it", async () => {
    // The parser named the document after the upload; the archive name comes from close and card.
    stubParse([
      { statements: [statement("upload (2).pdf", LAST4, [purchase("2026-09-03", "VITEST TIENDA", 12_345, "vitest-up-2")])] },
      { error: "unreadable", message: "no statement text" },
    ]);
    const out = await importCcStatementPdfsForAccount(card, [pdf("upload (2).pdf"), pdf("junk.pdf")]);
    const canonical = `2026-09-24 estado de cuenta tarjeta ${LAST4}.pdf`;
    expect(out).toMatchObject({
      account_id: card,
      files: ["upload (2).pdf", "junk.pdf"],
      saved_pdfs: [canonical],
      lines_parsed: 1,
      inserted: 1,
      statement_count: 1,
      parse_failures: ["junk.pdf: no statement text"],
    });
    const saved = path.join(archive, LAST4, "clp", canonical);
    expect(fs.readFileSync(saved, "utf8")).toBe("%PDF-vitest upload (2).pdf");
    expect(db.prepare(`SELECT source_pdf FROM cc_statements WHERE account_id = ?`).all(card)).toEqual([{ source_pdf: canonical }]);
  });

  it("refuses a statement with no period before writing or archiving anything", async () => {
    stubParse([{ statements: [statement("scan (3).pdf", LAST4, [purchase("2026-09-03", "VITEST KIOSCO", 1_000, "vitest-up-3")], null)] }]);
    await expect(importCcStatementPdfsForAccount(card, [pdf("scan (3).pdf")])).rejects.toThrow(/missing period_to for scan \(3\)\.pdf/);
    expect(db.prepare(`SELECT COUNT(*) AS n FROM cc_statements WHERE account_id = ?`).get(card)).toEqual({ n: 0 });
    expect(fs.existsSync(path.join(archive, LAST4))).toBe(false);
  });
});

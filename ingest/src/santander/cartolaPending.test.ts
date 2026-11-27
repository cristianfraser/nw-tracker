import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { documentOfFileLog, nextPendingCartolas, pendingAfterFailedSend, readPendingCartolas, writePendingCartolas, type PendingCartola } from "./cartolaPending.js";

const file = (name: string, status: string, problems: string[] = []) => ({ file: name, period_month: "2026-09", status, movements_parsed: 1, movements_imported: 0, error: null, problems });
const NOW = "2026-11-27T22:00:00.000Z";

describe("pending cartolas", () => {
  it("a refused or unreadable cartola stays pending with its problems; one that imports leaves", () => {
    const prev: PendingCartola[] = [{ document: "2026-08-31 cartola.pdf", since: "2026-11-20T22:00:00.000Z", status: "refused", problems: ["x"] }];
    const next = nextPendingCartolas(prev, () => true, [
      file("pdf:2026-08-31 cartola.pdf", "imported"),
      file("pdf:2026-09-30 cartola.pdf", "refused", ["the ledger at 2026-09-30 reads …"]),
      file("pdf:2026-10-30 cartola.pdf", "parse_error"),
      file("Octubre 2026.xlsx", "skipped_already_imported"),
    ], NOW);
    expect(next.resolved).toEqual(["2026-08-31 cartola.pdf"]);
    expect(next.pending.map((p) => [p.document, p.status, p.since])).toEqual([
      ["2026-09-30 cartola.pdf", "refused", NOW],
      ["2026-10-30 cartola.pdf", "parse_error", NOW],
    ]);
    expect(next.pending[0]!.problems).toEqual(["the ledger at 2026-09-30 reads …"]);
  });

  it("keeps the first day it stayed pending; a cuenta vista slice names its document", () => {
    expect(documentOfFileLog("pdf:cartola vista 84.pdf|2026-05")).toBe("cartola vista 84.pdf");
    const prev: PendingCartola[] = [{ document: "cartola vista 84.pdf", since: "2026-11-01T00:00:00.000Z", status: "refused", problems: [] }];
    const next = nextPendingCartolas(prev, () => true, [file("pdf:cartola vista 84.pdf|2026-05", "refused", ["p"]), file("pdf:cartola vista 84.pdf|2026-06", "imported")], NOW);
    expect(next.pending).toEqual([{ document: "cartola vista 84.pdf", since: "2026-11-01T00:00:00.000Z", status: "refused", problems: ["p"] }]);
  });

  it("one asked for that no reader found leaves; one not asked for, or a run whose PDF reader failed, keeps it", () => {
    const prev: PendingCartola[] = [{ document: "gone.pdf", since: NOW, status: "refused", problems: [] }];
    expect(nextPendingCartolas(prev, () => true, [], NOW)).toEqual({ pending: [], resolved: [], dropped: ["gone.pdf"] });
    expect(nextPendingCartolas(prev, () => false, [], NOW).pending).toEqual(prev);
    expect(nextPendingCartolas(prev, () => true, [file("pdf", "parse_error")], NOW).pending).toEqual(prev);
  });

  it("a reader that failed as a whole makes every PDF it was asked for pending with its error", () => {
    const prev: PendingCartola[] = [{ document: "old.pdf", since: "2026-11-01T00:00:00.000Z", status: "refused", problems: ["r"] }];
    const failure = { documents: ["filed today.pdf", "old.pdf"], error: "parse-checking-cartola-pdfs.py exited 1: boom" };
    const next = nextPendingCartolas(prev, () => true, [file("pdf", "parse_error"), file("Octubre 2026.xlsx", "imported")], NOW, failure);
    expect(next.dropped).toEqual([]);
    expect(next.pending).toEqual([
      { document: "filed today.pdf", since: NOW, status: "parse_error", problems: [failure.error] },
      { document: "old.pdf", since: "2026-11-01T00:00:00.000Z", status: "parse_error", problems: [failure.error] },
    ]);
  });

  it("a failed send makes every document of the run pending: statements not sent, unreadable ones with their own reason", () => {
    const prev: PendingCartola[] = [{ document: "a.pdf", since: "2026-11-01T00:00:00.000Z", status: "refused", problems: ["r"] }];
    const out = pendingAfterFailedSend(
      prev,
      [
        { document: "a.pdf", status: "not_sent", problem: "server down" },
        { document: "b.xlsx", status: "not_sent", problem: "server down" },
        { document: "c.pdf", status: "parse_error", problem: "no saldo" },
        { document: "pdf", status: "parse_error", problem: "reader died" },
      ],
      NOW
    );
    expect(out).toEqual([
      { document: "a.pdf", since: "2026-11-01T00:00:00.000Z", status: "not_sent", problems: ["server down"] },
      { document: "b.xlsx", since: NOW, status: "not_sent", problems: ["server down"] },
      { document: "c.pdf", since: NOW, status: "parse_error", problems: ["no saldo"] },
    ]);
  });

  it("is kept per account in one state file", () => {
    const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "cartola-pending-")), "state.json");
    writePendingCartolas("checking", [{ document: "a.pdf", since: NOW, status: "refused", problems: [] }], f);
    writePendingCartolas("cuenta-vista", [{ document: "b.pdf", since: NOW, status: "parse_error", problems: [] }], f);
    writePendingCartolas("checking", [], f);
    expect(readPendingCartolas("checking", f)).toEqual([]);
    expect(readPendingCartolas("cuenta-vista", f).map((p) => p.document)).toEqual(["b.pdf"]);
    expect(fs.readdirSync(path.dirname(f))).toEqual(["state.json"]);
  });
});

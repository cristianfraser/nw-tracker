import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { IngestResult } from "nw-tracker-contracts";
import { sendStaged } from "./stagedFiles.js";
import { readStepResult, reportStepResult, STEP_RESULT_ENV } from "./stepResult.js";

function result(over: Partial<IngestResult> = {}): IngestResult {
  return { status: "applied", kind: "test.kind", schema_version: 1, retry: false, dry_run: false, ...over };
}

function staging(names: string[]): { dir: string; files: string[] } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nw-staged-"));
  return { dir, files: names.map((n) => (fs.writeFileSync(path.join(dir, n), n), path.join(dir, n))) };
}

describe("sendStaged", () => {
  it("archives what the server is done with and keeps a retry or a conflict staged", async () => {
    const { dir, files } = staging(["a.json", "b.json", "c.json"]);
    const answers: Record<string, IngestResult> = {
      "a.json": result(),
      "b.json": result({ retry: true }),
      "c.json": result({ status: "conflict", message: "disagrees" }),
    };
    const reported: [string, string | null][] = [];
    const out = await sendStaged(files, {
      path: (f) => f,
      send: async (f) => answers[path.basename(f)]!,
      report: (f, _r, archivedTo) => void reported.push([path.basename(f), archivedTo]),
    });
    expect(out).toEqual({ exitCode: 0, sent: 3, conflicts: 1 });
    expect(fs.readdirSync(dir).sort()).toEqual(["b.json", "c.json", "imported"]);
    expect(reported).toEqual([
      ["a.json", path.join(dir, "imported", "a.json")],
      ["b.json", null],
      ["c.json", null],
    ]);
  });

  it("stops at the first request that fails, leaving the rest staged", async () => {
    const { dir, files } = staging(["a.json", "b.json"]);
    const out = await sendStaged(files, {
      path: (f) => f,
      send: async () => {
        throw new Error("down");
      },
      report: () => undefined,
    });
    expect(out.exitCode).toBe(1);
    expect(fs.readdirSync(dir).sort()).toEqual(["a.json", "b.json"]);
  });
});

describe("step results", () => {
  it("merges reports into the run's file and reads nothing outside a run", () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "nw-step-")), "1.json");
    reportStepResult({ staged: 2 }, {});
    expect(readStepResult(file)).toEqual({});
    reportStepResult({ staged: 2 }, { [STEP_RESULT_ENV]: file });
    reportStepResult({ inserted: 1 }, { [STEP_RESULT_ENV]: file });
    expect(readStepResult(file)).toEqual({ staged: 2, inserted: 1 });
  });
});

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { STEP_RESULT_ENV, readStepResult, reportStepResult } from "../stepResult.js";
import { parseReconciliationPath, withheldStatementProblems } from "./parseReconciliation.js";

describe("withheld card statements", () => {
  let root: string;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "nw-cc-reconcile-"));
  });
  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("names each withheld statement with its printed figure, parsed sum and difference; the others are not problems", () => {
    const file = parseReconciliationPath(path.join(root, "parsed.csv"));
    expect(path.basename(file)).toBe("parsed.reconciliation.jsonl");
    const entry = (source_pdf: string, withheld: boolean, checks: object[]) =>
      JSON.stringify({ source_pdf, currency: "clp", ok: !withheld, withheld, checks });
    fs.writeFileSync(
      file,
      [
        entry("2036-07-22 estado de cuenta tarjeta 4141.pdf", false, [{ code: "operaciones_excess", ok: true, expected: 100, actual: 100, delta: 0 }]),
        entry("2036-08-22 estado de cuenta tarjeta 4141.pdf", true, [
          { code: "operaciones_shortfall", ok: true, expected: 100000, actual: 101500, delta: 1500 },
          { code: "operaciones_excess", ok: false, expected: 100000, actual: 101500, delta: 1500 },
        ]),
      ].join("\n") + "\n"
    );
    const problems = withheldStatementProblems(file);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/^2036-08-22 estado de cuenta tarjeta 4141\.pdf \(CLP\) withheld/);
    expect(problems[0]).toMatch(/operaciones_excess: printed 100000, parsed 101500, difference 1500/);
    expect(problems[0]).not.toMatch(/operaciones_shortfall/);
  });

  it("a statement the reconcile raised on is named with the error", () => {
    const file = path.join(root, "r.jsonl");
    fs.writeFileSync(file, `${JSON.stringify({ source_pdf: "x.pdf", currency: "clp", ok: false, withheld: true, checks: [], error: "ValueError: no parser layout" })}\n`);
    expect(withheldStatementProblems(file)).toEqual([
      "x.pdf (CLP) withheld — its reconcile failed: ValueError: no parser layout. Its rows on file are untouched; fix the parse (or quarantine the PDF).",
    ]);
  });

  it("reads no file as no withheld statement", () => {
    expect(withheldStatementProblems(path.join(root, "missing.jsonl"))).toEqual([]);
  });

  it("the step's problems add up across the commands that report them", () => {
    const env = { [STEP_RESULT_ENV]: path.join(root, "step.json") };
    reportStepResult({ problems: ["withheld statement"] }, env);
    reportStepResult({ problems: ["import refused"] }, env);
    expect(readStepResult(env[STEP_RESULT_ENV]!).problems).toEqual(["withheld statement", "import refused"]);
  });
});

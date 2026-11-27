import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readStepResult, reportStepResult, STEP_RESULT_ENV } from "./stepResult.js";

describe("reportStepResult", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
  });

  it("adds up the notices of several reports while other fields take the latest", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "step-result-"));
    dirs.push(dir);
    const env = { [STEP_RESULT_ENV]: path.join(dir, "1.json") };
    reportStepResult({ staged: 1, notices: ["Held, not imported: A.pdf"] }, env);
    reportStepResult({ staged: 2 }, env);
    reportStepResult({ notices: ["Held, not imported: B.pdf"] }, env);
    expect(readStepResult(env[STEP_RESULT_ENV]!)).toEqual({ staged: 2, notices: ["Held, not imported: A.pdf", "Held, not imported: B.pdf"] });
  });

  it("writes no empty notice list", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "step-result-"));
    dirs.push(dir);
    const env = { [STEP_RESULT_ENV]: path.join(dir, "1.json") };
    reportStepResult({ notices: [] }, env);
    expect(readStepResult(env[STEP_RESULT_ENV]!)).toEqual({});
  });
});

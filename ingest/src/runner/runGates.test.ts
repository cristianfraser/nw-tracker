import { describe, expect, it } from "vitest";
import { parseNonNegativeNumber, parsePort } from "../numberArgs.js";
import { readRunGates } from "./runGates.js";

describe("readRunGates", () => {
  it("reads every gate off from an empty environment", () => {
    expect(readRunGates({})).toEqual({
      dryRun: false,
      fintualApply: false,
      racionalApply: false,
      statementJsonApply: false,
      fullReimport: false,
      afpUnoApply: false,
      afcApply: false,
    });
  });

  it("reads the flag rule's spellings", () => {
    const gates = readRunGates({
      INGEST_RUN_DRY: "0",
      NW_TRACKER_FINTUAL_APPLY: "1",
      NW_TRACKER_RACIONAL_APPLY: "true",
      NW_TRACKER_STATEMENT_JSON_APPLY: " YES ",
      NW_TRACKER_FULL_REIMPORT: "no",
      NW_TRACKER_AFP_UNO_APPLY: "",
    });
    expect(gates).toMatchObject({
      dryRun: false,
      fintualApply: true,
      racionalApply: true,
      statementJsonApply: true,
      fullReimport: false,
      afpUnoApply: false,
      afcApply: false,
    });
  });

  it("a mistyped gate throws, naming the variable", () => {
    expect(() => readRunGates({ NW_TRACKER_AFC_APPLY: "ture" })).toThrow('NW_TRACKER_AFC_APPLY="ture": expected 1/true/yes or 0/false/no');
    expect(() => readRunGates({ INGEST_RUN_DRY: "on" })).toThrow(/INGEST_RUN_DRY/);
  });
});

describe("number arguments", () => {
  it("a port: unset is the default, anything but a port throws", () => {
    expect(parsePort("INGEST_SERVICE_PORT", undefined, 3002)).toBe(3002);
    expect(parsePort("INGEST_SERVICE_PORT", " ", 3002)).toBe(3002);
    expect(parsePort("INGEST_SERVICE_PORT", "3399", 3002)).toBe(3399);
    for (const bad of ["abc", "0", "70000", "30.5"]) {
      expect(() => parsePort("INGEST_SERVICE_PORT", bad, 3002)).toThrow(`INGEST_SERVICE_PORT=${JSON.stringify(bad)}: expected a port`);
    }
  });

  it("a flag's number: not a number ≥ 0 throws", () => {
    expect(parseNonNegativeNumber("--min-interval", "45")).toBe(45);
    expect(parseNonNegativeNumber("--min-interval", "0")).toBe(0);
    for (const bad of ["abc", "", "-5"]) {
      expect(() => parseNonNegativeNumber("--min-interval", bad)).toThrow(`--min-interval=${JSON.stringify(bad)}: expected a number ≥ 0`);
    }
  });
});

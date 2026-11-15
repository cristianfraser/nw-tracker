import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { hasDocument } from "./documentLedger.js";
import { readBrokerEmailState, resolveBrokerEmailStatePath } from "./email/fetch.js";
import { lastRunAt } from "./runGuard.js";
import { readJsonStateFile } from "./stateFile.js";

let dir = "";
let previous: string | undefined;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "vitest-ingest-state-"));
  previous = process.env.CFRASER_CSV_DIR;
  process.env.CFRASER_CSV_DIR = dir;
});

afterEach(() => {
  if (previous === undefined) delete process.env.CFRASER_CSV_DIR;
  else process.env.CFRASER_CSV_DIR = previous;
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("readJsonStateFile", () => {
  it("no file is the empty state; an object is read", () => {
    const file = path.join(dir, "state.json");
    expect(readJsonStateFile(file)).toBeNull();
    fs.writeFileSync(file, JSON.stringify({ a: 1 }));
    expect(readJsonStateFile(file)).toEqual({ a: 1 });
  });

  it("a corrupt file throws, naming it", () => {
    const file = path.join(dir, "state.json");
    fs.writeFileSync(file, "{ truncated");
    expect(() => readJsonStateFile(file)).toThrow(`${file} is not valid JSON — fix or delete it`);
    for (const notAnObject of ["[]", "null", "3"]) {
      fs.writeFileSync(file, notAnObject);
      expect(() => readJsonStateFile(file)).toThrow(`${file} is not a JSON object — fix or delete it`);
    }
  });
});

describe("the state readers on it", () => {
  it("the bank run guard: no history without a file, a throw on a corrupt one", () => {
    expect(lastRunAt("santander")).toBeNull();
    const file = path.join(dir, ".scraper-run-state.json");
    fs.writeFileSync(file, JSON.stringify({ santander: "2031-02-03T04:05:06.000Z" }));
    expect(lastRunAt("santander")?.toISOString()).toBe("2031-02-03T04:05:06.000Z");
    fs.writeFileSync(file, "not json");
    expect(() => lastRunAt("santander")).toThrow(/\.scraper-run-state\.json is not valid JSON/);
  });

  it("the document ledger: nothing fetched without a file, a throw on a corrupt one", () => {
    expect(hasDocument("lider", "statement", "2031-02")).toBe(false);
    fs.writeFileSync(path.join(dir, ".scraper-documents.json"), "not json");
    expect(() => hasDocument("lider", "statement", "2031-02")).toThrow(/\.scraper-documents\.json is not valid JSON/);
  });

  it("the broker mail watermark: none without a file, a throw on a corrupt one", () => {
    expect(readBrokerEmailState()).toBeNull();
    fs.writeFileSync(resolveBrokerEmailStatePath(), "not json");
    expect(() => readBrokerEmailState()).toThrow(/\.broker-email-state\.json is not valid JSON/);
  });
});

import { describe, expect, it } from "vitest";
import type { StepResult } from "../stepResult.js";
import { runHourly, type HourlyOptions } from "./hourly.js";
import { runNightly, type NightlyOptions } from "./nightly.js";
import { santanderVeto } from "./runRequest.js";
import type { StepRunner } from "./steps.js";

/**
 * A runner that executes nothing: records each ingest command («script args»), plays the given
 * step results (keyed by script, or by «server-task <task>») and failures.
 */
function fakeRunner(results: Record<string, StepResult> = {}, failing: string[] = []) {
  const calls: string[] = [];
  const notes: string[] = [];
  const x: StepRunner = {
    steps: [],
    note: (m) => void notes.push(m),
    async step(label, command) {
      calls.push([command.script, ...command.args].join(" "));
      const key = command.script === "server-task" ? `server-task ${command.args[0]}` : command.script;
      const ok = !failing.includes(key);
      x.steps.push({ label, ok, seconds: 0 });
      return { ok, result: results[key] ?? {} };
    },
  };
  return { x, calls, notes };
}

const NIGHTLY: NightlyOptions = {
  dryRun: false,
  statementJsonApply: true,
  fullReimport: false,
  fintualApply: true,
  racionalApply: true,
  afpUnoFetch: null,
  afpUnoApply: true,
  afcFetch: null,
  afcApply: true,
  payslips: null,
};

describe("runNightly", () => {
  it("runs the nightly sequence with the production flags", async () => {
    const { x, calls } = fakeRunner();
    const result = await runNightly(x, NIGHTLY);
    expect(calls).toEqual([
      "fetch:santander",
      "fetch:santander-docs",
      "fetch:lider-boletas",
      "fetch:lider-statements",
      "fetch:fintual-docs",
      "fetch:apple-mail",
      "fetch:afc-cartolas",
      "import:cfraser-inbox",
      "import:santander-movements",
      "import:checking-usd-movements",
      "server-task cc_payment_mirrors",
      "server-task cc_bank_cupo_check",
      "server-task mortgage_card_match_check",
      "import:transfer-mails",
      "import:payment-receipt-mails",
      "import:utility-bills",
      "import:metlife-receipts",
      "import:apple-mail",
      "fetch:emails",
      "check:broker-emails",
      "import:fintual-emails --apply",
      "import:fintual-acciones --apply",
      "import:fintual-wallet --apply",
      "import:racional-emails --apply",
      "import:santander-statements --apply",
    ]);
    expect(result.santander).toEqual({ mode: "nightly", outcome: "ok", note: null });
  });

  it("fetches Racional only when the e-mail check named it, and keeps going after a failure", async () => {
    const { x, calls } = fakeRunner({ "import:racional-emails": { read_brokers: ["racional"] } }, ["fetch:santander"]);
    const result = await runNightly(x, { ...NIGHTLY, racionalApply: false });
    expect(calls.slice(-4)).toEqual([
      "import:racional-emails",
      "fetch:racional",
      "import:racional-movements",
      "import:santander-statements --apply",
    ]);
    expect(x.steps.map((s) => s.label)).toContain("Racional movements (report only)");
    expect(result.santander).toEqual({ mode: "nightly", outcome: "failed", note: null });
    expect(x.steps.filter((s) => !s.ok).map((s) => s.label)).toEqual(["fetch Santander"]);
  });

  it("reads AFP UNO only when the server asks, writing only with the apply flag", async () => {
    const asked = { reason: "no clean import since 2030-10-10" };
    const { x, calls } = fakeRunner();
    await runNightly(x, { ...NIGHTLY, afpUnoFetch: asked });
    expect(calls).toContain("fetch:afp-uno --apply");
    const report = fakeRunner();
    await runNightly(report.x, { ...NIGHTLY, afpUnoFetch: asked, afpUnoApply: false });
    expect(report.x.steps.map((s) => s.label)).toContain("AFP UNO (report only)");
    expect(report.calls).toContain("fetch:afp-uno");
    const quiet = fakeRunner();
    await runNightly(quiet.x, NIGHTLY);
    expect(quiet.calls.some((c) => c.includes("fetch:afp-uno"))).toBe(false);
  });

  it("reads the AFC when the server expects a contribution or a cartola mail was staged, writing only with the apply flag", async () => {
    const asked = { reason: "no AFC contribution for 2026-09 in the ledger yet", expected_period: "2026-09", overdue: false };
    const { x, calls } = fakeRunner();
    await runNightly(x, { ...NIGHTLY, afcFetch: asked });
    expect(calls).toContain("fetch:afc --apply --expect=2026-09");
    const overdue = fakeRunner();
    await runNightly(overdue.x, { ...NIGHTLY, afcFetch: { ...asked, overdue: true } });
    expect(overdue.calls).toContain("fetch:afc --apply --expect=2026-09 --overdue");
    const cartola = fakeRunner({ "fetch:afc-cartolas": { staged: 1 } });
    await runNightly(cartola.x, NIGHTLY);
    expect(cartola.calls).toContain("fetch:afc --apply");
    const report = fakeRunner();
    await runNightly(report.x, { ...NIGHTLY, afcFetch: asked, afcApply: false });
    expect(report.x.steps.map((s) => s.label)).toContain("AFC (report only)");
    expect(report.calls).toContain("fetch:afc --expect=2026-09");
    const quiet = fakeRunner();
    await runNightly(quiet.x, NIGHTLY);
    expect(quiet.calls.some((c) => c === "fetch:afc" || c.includes("fetch:afc --"))).toBe(false);
  });

  it("imports payslips when the server asks, reading the portal only when told to fetch", async () => {
    const fetched = fakeRunner();
    await runNightly(fetched.x, { ...NIGHTLY, payslips: { fetch: true, reason: "no payslip for 2030-09 yet" } });
    expect(fetched.calls.filter((c) => /buk|payroll|previred/.test(c))).toEqual([
      "fetch:buk-payslips",
      "parse:payroll-liquidaciones",
      "import:previred-indicators",
      "import:payroll-liquidaciones --no-strict",
    ]);
    const importOnly = fakeRunner();
    await runNightly(importOnly.x, { ...NIGHTLY, payslips: { fetch: false, reason: "payslip 2030-09 has no deposit paired yet" } });
    expect(importOnly.calls.some((c) => c.includes("fetch:buk-payslips"))).toBe(false);
    expect(importOnly.calls).toContain("import:payroll-liquidaciones --no-strict");
    const quiet = fakeRunner();
    await runNightly(quiet.x, NIGHTLY);
    expect(quiet.calls.some((c) => /buk|payroll/.test(c))).toBe(false);
  });


  it("opens no bank session in a dry run", async () => {
    const { x, calls } = fakeRunner();
    expect((await runNightly(x, { ...NIGHTLY, dryRun: true })).santander).toBeNull();
    expect(calls.some((c) => c.split(" ")[0] === "fetch:santander" || c.includes("cc_bank_cupo_check"))).toBe(false);
  });
});

const HOURLY: HourlyOptions = {
  dryRun: false,
  fintualApply: true,
  racionalApply: true,
  santanderFetch: null,
  santanderVeto: () => null,
  groceryInboxCount: () => 0,
};

describe("runHourly", () => {
  it("fetches mail only, and imports nothing in a quiet hour", async () => {
    const { x, calls, notes } = fakeRunner({ "fetch:emails": { staged: 0 } });
    expect(await runHourly(x, HOURLY)).toEqual({ santander: null, activity: false });
    expect(calls).toEqual([
      "fetch:santander-docs",
      "fetch:lider-statements",
      "fetch:lider-boletas",
      "fetch:fintual-docs",
      "fetch:apple-mail",
      "fetch:emails",
      "import:transfer-mails --days=2",
      "import:utility-bills --only-if-new",
      "import:metlife-receipts --days=3",
      "import:fintual-wallet --apply",
    ]);
    expect(notes).toContain("=== inbox pipeline (skipped — nothing new staged)");
  });

  it("imports what the hour staged", async () => {
    const { x, calls } = fakeRunner({
      "fetch:santander-docs": { staged: 2 },
      "fetch:emails": { staged: 1 },
    });
    expect((await runHourly(x, HOURLY)).activity).toBe(true);
    expect(calls.slice(6)).toEqual([
      "import:cfraser-inbox",
      "import:fintual-emails --apply",
      "import:racional-emails --apply",
      "import:transfer-mails --days=2",
      "import:utility-bills --only-if-new",
      "import:metlife-receipts --days=3",
      "import:fintual-wallet --apply",
    ]);
  });


  it("counts a movement written from a transfer mail as activity", async () => {
    const { x } = fakeRunner({
      "fetch:emails": { staged: 0 },
      "import:transfer-mails": { inserted: 1 },
    });
    expect((await runHourly(x, HOURLY)).activity).toBe(true);
  });

  it("reads the bill mails every hour and counts a new one as activity", async () => {
    const quiet = fakeRunner({ "fetch:emails": { staged: 0 }, "import:utility-bills": { staged: 0 } });
    expect((await runHourly(quiet.x, HOURLY)).activity).toBe(false);
    expect(quiet.calls).toContain("import:utility-bills --only-if-new");
    const mailed = fakeRunner({ "fetch:emails": { staged: 0 }, "import:utility-bills": { staged: 1 } });
    expect((await runHourly(mailed.x, HOURLY)).activity).toBe(true);
  });

  it("reads MetLife's receipts every hour and counts a sent one as activity", async () => {
    const quiet = fakeRunner({ "fetch:emails": { staged: 0 }, "import:metlife-receipts": { staged: 0 } });
    expect((await runHourly(quiet.x, HOURLY)).activity).toBe(false);
    expect(quiet.calls).toContain("import:metlife-receipts --days=3");
    const paid = fakeRunner({ "fetch:emails": { staged: 0 }, "import:metlife-receipts": { staged: 1, inserted: 1 } });
    expect((await runHourly(paid.x, HOURLY)).activity).toBe(true);
    const dry = fakeRunner();
    await runHourly(dry.x, { ...HOURLY, dryRun: true });
    expect(dry.calls).toContain("import:metlife-receipts --days=3 --dry-run");
  });

  it("reads the Fintual wallet every hour and counts a booked interest credit as activity", async () => {
    const quiet = fakeRunner({ "fetch:emails": { staged: 0 }, "import:fintual-wallet": { inserted: 0 } });
    expect((await runHourly(quiet.x, HOURLY)).activity).toBe(false);
    const booked = fakeRunner({ "fetch:emails": { staged: 0 }, "import:fintual-wallet": { inserted: 1 } });
    expect((await runHourly(booked.x, HOURLY)).activity).toBe(true);
    const report = fakeRunner();
    await runHourly(report.x, { ...HOURLY, fintualApply: false });
    expect(report.calls).toContain("import:fintual-wallet");
  });

  it("runs a photo waiting in the grocery inbox through the pipeline", async () => {
    const { x, calls } = fakeRunner();
    await runHourly(x, { ...HOURLY, groceryInboxCount: () => 1 });
    expect(calls).toContain("import:cfraser-inbox");
  });

  it("reads nothing more when every balance agrees", async () => {
    const { x, calls } = fakeRunner({ "fetch:santander": { fetch: [], differs: false } });
    const result = await runHourly(x, { ...HOURLY, santanderFetch: { mode: "balance-poll", reason: "hourly" } });
    expect(result.santander).toEqual({ mode: "balance-poll", outcome: "ok", note: "every product agrees" });
    expect(calls.slice(6)).toEqual([
      "fetch:santander --balance-poll",
      "import:transfer-mails --days=2",
      "import:utility-bills --only-if-new",
      "import:metlife-receipts --days=3",
      "import:fintual-wallet --apply",
    ]);
  });

  it("imports the listings the poll read, then judges again", async () => {
    const { x, calls } = fakeRunner({
      "fetch:santander": { fetch: ["card-movements", "checking-movements", "checking-usd-movements"], differs: true },
    });
    const result = await runHourly(x, { ...HOURLY, santanderFetch: { mode: "balance-poll", reason: "hourly" } });
    expect(result).toEqual({
      santander: { mode: "balance-poll", outcome: "ok", note: "read card-movements, checking-movements, checking-usd-movements" },
      activity: true,
    });
    expect(calls.slice(6)).toEqual([
      "fetch:santander --balance-poll",
      "import:santander-movements",
      "server-task cc_payment_mirrors",
      "import:checking-usd-movements",
      "import:cfraser-inbox",
      "server-task cc_bank_cupo_check --recheck",
      "import:transfer-mails --days=2",
      "import:utility-bills --only-if-new",
      "import:metlife-receipts --days=3",
      "import:fintual-wallet --apply",
    ]);
  });

  it("judges again a difference no listing can explain (the cuenta vista)", async () => {
    const { x, calls } = fakeRunner({
      "fetch:santander": { fetch: [], differs: true },
    });
    await runHourly(x, { ...HOURLY, santanderFetch: { mode: "balance-poll", reason: "hourly" } });
    expect(calls).toContain("server-task cc_bank_cupo_check --recheck");
    expect(calls).not.toContain("import:cfraser-inbox");
  });

  it("declines a requested poll it cannot safely make", async () => {
    const { x, calls, notes } = fakeRunner();
    const result = await runHourly(x, {
      ...HOURLY,
      santanderFetch: { mode: "balance-poll", reason: "hourly" },
      santanderVeto: () => "login latched off after a credentials rejection",
    });
    expect(result.santander).toEqual({
      mode: "balance-poll",
      outcome: "vetoed",
      note: "login latched off after a credentials rejection",
    });
    expect(calls).not.toContain("fetch:santander --balance-poll");
    expect(notes).toContain("=== Santander balance-poll (declined — login latched off after a credentials rejection)");
  });
});

it("a poll the server never answered reads nothing", async () => {
  const { x, calls } = fakeRunner({ "fetch:santander": {} }, ["fetch:santander"]);
  const result = await runHourly(x, { ...HOURLY, santanderFetch: { mode: "balance-poll", reason: "hourly" } });
  expect(result.santander).toEqual({ mode: "balance-poll", outcome: "failed", note: "the server never answered" });
  expect(calls).not.toContain("import:santander-movements");
});

describe("santanderVeto", () => {
  const now = new Date("2026-09-30T15:00:00Z");
  const markers = {};
  it("declines when latched or tried less than 35 min ago", () => {
    expect(santanderVeto({ last_attempt_at: null, last_success_at: null, login_latched: true, ...markers }, now)).toMatch(/latched/);
    expect(
      santanderVeto({ last_attempt_at: "2026-09-30T14:40:00.000Z", last_success_at: null, login_latched: false, ...markers }, now)
    ).toBe("last attempt 20 min ago — waiting 35 min");
    expect(santanderVeto({ last_attempt_at: "2026-09-30T14:20:00.000Z", last_success_at: null, login_latched: false, ...markers }, now)).toBeNull();
  });
});

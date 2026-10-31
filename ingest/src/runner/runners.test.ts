import { describe, expect, it } from "vitest";
import { brokerMessageCount, runHourly, savedCount, type HourlyOptions } from "./hourly.js";
import { runNightly, type NightlyOptions } from "./nightly.js";
import { santanderVeto } from "./runRequest.js";
import type { StepRunner } from "./steps.js";

/** A runner that executes nothing: records each command, plays the given outputs and failures. */
function fakeRunner(outputs: Record<string, string> = {}, failing: string[] = []) {
  const calls: string[] = [];
  const notes: string[] = [];
  const x: StepRunner = {
    steps: [],
    note: (m) => void notes.push(m),
    async step(label, argv) {
      calls.push(argv.slice(1).join(" "));
      const script = argv[2]!;
      const ok = !failing.includes(script);
      x.steps.push({ label, ok, seconds: 0 });
      return { ok, output: outputs[script] ?? "" };
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
  racionalNeeded: () => false,
  afpUnoFetch: null,
  afpUnoApply: true,
  afcFetch: null,
  afcApply: true,
  payslips: null,
  mortgageSheet: null,
};

describe("runNightly", () => {
  it("runs daily-run.sh's sequence with the production flags", async () => {
    const { x, calls } = fakeRunner();
    const result = await runNightly(x, NIGHTLY);
    expect(calls).toEqual([
      "run fetch:santander -- --background",
      "run fetch:santander-docs",
      "run fetch:lider-boletas",
      "run fetch:lider-statements",
      "run fetch:fintual-docs",
      "run fetch:apple-mail",
      "run fetch:afc-cartolas",
      "run import:cfraser-inbox",
      "run import:santander-movements",
      "run import:checking-usd-movements",
      "run convert:cc-payment-mirrors",
      "run check:cc-bank-cupo",
      "run check:mortgage-card-match",
      "run import:transfer-mails",
      "run import:payment-receipt-mails",
      "run import:utility-bills",
      "run import:apple-mail",
      "run fetch:emails",
      "run check:broker-emails",
      "run import:fintual-emails -- --apply",
      "run import:fintual-acciones -- --apply",
      "run import:fintual-wallet -- --apply",
      "run import:racional-emails -- --apply",
      "run import:santander-statements -- --apply",
    ]);
    expect(result.santander).toEqual({ mode: "nightly", outcome: "ok", note: null });
  });

  it("fetches Racional only when the e-mail check named it, and keeps going after a failure", async () => {
    const { x, calls } = fakeRunner({}, ["fetch:santander"]);
    const result = await runNightly(x, { ...NIGHTLY, racionalApply: false, racionalNeeded: () => true });
    expect(calls.slice(-4)).toEqual([
      "run import:racional-emails",
      "run fetch:racional -- --background",
      "run import:racional-movements",
      "run import:santander-statements -- --apply",
    ]);
    expect(x.steps.map((s) => s.label)).toContain("Racional movements (report only)");
    expect(result.santander).toEqual({ mode: "nightly", outcome: "failed", note: null });
    expect(x.steps.filter((s) => !s.ok).map((s) => s.label)).toEqual(["fetch Santander"]);
  });

  it("reads AFP UNO only when the server asks, writing only with the apply flag", async () => {
    const asked = { reason: "no clean import since 2030-10-10" };
    const { x, calls } = fakeRunner();
    await runNightly(x, { ...NIGHTLY, afpUnoFetch: asked });
    expect(calls).toContain("run fetch:afp-uno -- --background --apply");
    const report = fakeRunner();
    await runNightly(report.x, { ...NIGHTLY, afpUnoFetch: asked, afpUnoApply: false });
    expect(report.x.steps.map((s) => s.label)).toContain("AFP UNO (report only)");
    expect(report.calls).toContain("run fetch:afp-uno -- --background");
    const quiet = fakeRunner();
    await runNightly(quiet.x, NIGHTLY);
    expect(quiet.calls.some((c) => c.includes("fetch:afp-uno"))).toBe(false);
  });

  it("reads the AFC when the server expects a contribution or a cartola mail was staged, writing only with the apply flag", async () => {
    const asked = { reason: "no AFC contribution for 2026-09 in the ledger yet", expected_period: "2026-09", overdue: false };
    const { x, calls } = fakeRunner();
    await runNightly(x, { ...NIGHTLY, afcFetch: asked });
    expect(calls).toContain("run fetch:afc -- --background --apply --expect=2026-09");
    const overdue = fakeRunner();
    await runNightly(overdue.x, { ...NIGHTLY, afcFetch: { ...asked, overdue: true } });
    expect(overdue.calls).toContain("run fetch:afc -- --background --apply --expect=2026-09 --overdue");
    const cartola = fakeRunner({ "fetch:afc-cartolas": "Summary: 1 saved, 0 skipped" });
    await runNightly(cartola.x, NIGHTLY);
    expect(cartola.calls).toContain("run fetch:afc -- --background --apply");
    const report = fakeRunner();
    await runNightly(report.x, { ...NIGHTLY, afcFetch: asked, afcApply: false });
    expect(report.x.steps.map((s) => s.label)).toContain("AFC (report only)");
    expect(report.calls).toContain("run fetch:afc -- --background --expect=2026-09");
    const quiet = fakeRunner();
    await runNightly(quiet.x, NIGHTLY);
    expect(quiet.calls.some((c) => c === "run fetch:afc -- --background" || c.includes("fetch:afc --"))).toBe(false);
  });

  it("imports payslips when the server asks, reading the portal only when told to fetch", async () => {
    const fetched = fakeRunner();
    await runNightly(fetched.x, { ...NIGHTLY, payslips: { fetch: true, reason: "no payslip for 2030-09 yet" } });
    expect(fetched.calls.filter((c) => /buk|payroll|previred/.test(c))).toEqual([
      "run fetch:buk-payslips -- --background",
      "run parse:payroll-liquidaciones",
      "run import:previred-indicators",
      "run import:payroll-liquidaciones -- --no-strict",
    ]);
    const importOnly = fakeRunner();
    await runNightly(importOnly.x, { ...NIGHTLY, payslips: { fetch: false, reason: "payslip 2030-09 has no deposit paired yet" } });
    expect(importOnly.calls.some((c) => c.includes("fetch:buk-payslips"))).toBe(false);
    expect(importOnly.calls).toContain("run import:payroll-liquidaciones -- --no-strict");
    const quiet = fakeRunner();
    await runNightly(quiet.x, NIGHTLY);
    expect(quiet.calls.some((c) => /buk|payroll/.test(c))).toBe(false);
  });

  it("reads the mortgage sheet after the inbox pipeline when the server says it is stale", async () => {
    const { x, calls, notes } = fakeRunner();
    await runNightly(x, { ...NIGHTLY, mortgageSheet: { reason: "no mortgage cuota in the ledger since 2030-10-11" } });
    expect(calls.indexOf("run import:mortgage-sheet")).toBe(calls.indexOf("run import:cfraser-inbox") + 1);
    const without = fakeRunner();
    await runNightly(without.x, NIGHTLY);
    expect(without.calls).not.toContain("run import:mortgage-sheet");
    expect(without.notes).toContain("=== Mortgage sheet (not stale)");
    expect(notes).not.toContain("=== Mortgage sheet (not stale)");
  });

  it("opens no bank session in a dry run", async () => {
    const { x, calls } = fakeRunner();
    expect((await runNightly(x, { ...NIGHTLY, dryRun: true })).santander).toBeNull();
    expect(calls.some((c) => c.startsWith("run fetch:santander --") || c.includes("check:cc-bank-cupo"))).toBe(false);
  });
});

const HOURLY: HourlyOptions = {
  dryRun: false,
  fintualApply: true,
  racionalApply: true,
  santanderFetch: null,
  santanderVeto: () => null,
  onSantanderAttempt: () => {},
  groceryInboxCount: () => 0,
  mortgageSheet: null,
};

describe("runHourly", () => {
  it("fetches mail only, and imports nothing in a quiet hour", async () => {
    const { x, calls, notes } = fakeRunner({ "fetch:emails": "e-mail: 0 broker message(s)" });
    expect(await runHourly(x, HOURLY)).toEqual({ santander: null, activity: false });
    expect(calls).toEqual([
      "run fetch:santander-docs",
      "run fetch:lider-statements",
      "run fetch:lider-boletas",
      "run fetch:fintual-docs",
      "run fetch:apple-mail",
      "run fetch:emails",
      "run import:transfer-mails -- --days=2",
      "run import:fintual-wallet -- --apply",
    ]);
    expect(notes).toContain("=== inbox pipeline (skipped — nothing new staged)");
    expect(notes).toContain("=== Mortgage sheet (not stale)");
  });

  it("imports what the hour staged", async () => {
    const { x, calls } = fakeRunner({
      "fetch:santander-docs": "Summary: 2 saved, 3 skipped",
      "fetch:emails": "e-mail: 1 broker message(s)",
    });
    expect((await runHourly(x, HOURLY)).activity).toBe(true);
    expect(calls.slice(6)).toEqual([
      "run import:cfraser-inbox",
      "run import:fintual-emails -- --apply",
      "run import:racional-emails -- --apply",
      "run import:transfer-mails -- --days=2",
      "run import:fintual-wallet -- --apply",
    ]);
  });

  it("reads the mortgage sheet when the server says it is stale, and counts a written cuota as activity", async () => {
    const stale = { reason: "no mortgage cuota in the ledger since 2030-10-11" };
    const quiet = fakeRunner({ "fetch:emails": "e-mail: 0 broker message(s)", "import:mortgage-sheet": "mortgage sheet: 0 row(s) written, 25 checked" });
    expect((await runHourly(quiet.x, { ...HOURLY, mortgageSheet: stale })).activity).toBe(false);
    expect(quiet.calls).toContain("run import:mortgage-sheet");
    const written = fakeRunner({ "fetch:emails": "e-mail: 0 broker message(s)", "import:mortgage-sheet": "mortgage sheet: 1 row(s) written, 24 checked" });
    expect((await runHourly(written.x, { ...HOURLY, mortgageSheet: stale })).activity).toBe(true);
  });

  it("counts a movement written from a transfer mail as activity", async () => {
    const { x } = fakeRunner({
      "fetch:emails": "e-mail: 0 broker message(s)",
      "import:transfer-mails": "  movement written from the mail: 9, 2030-10-07 $29597 on account 22",
    });
    expect((await runHourly(x, HOURLY)).activity).toBe(true);
  });

  it("reads the Fintual wallet every hour and counts a booked interest credit as activity", async () => {
    const quiet = fakeRunner({ "fetch:emails": "e-mail: 0 broker message(s)", "import:fintual-wallet": "  → 0 inserted, 2 already present" });
    expect((await runHourly(quiet.x, HOURLY)).activity).toBe(false);
    const booked = fakeRunner({ "fetch:emails": "e-mail: 0 broker message(s)", "import:fintual-wallet": "  → 1 inserted, 1 already present" });
    expect((await runHourly(booked.x, HOURLY)).activity).toBe(true);
    const report = fakeRunner();
    await runHourly(report.x, { ...HOURLY, fintualApply: false });
    expect(report.calls).toContain("run import:fintual-wallet");
  });

  it("runs a photo waiting in the grocery inbox through the pipeline", async () => {
    const { x, calls } = fakeRunner();
    await runHourly(x, { ...HOURLY, groceryInboxCount: () => 1 });
    expect(calls).toContain("run import:cfraser-inbox");
  });

  it("makes the bank fetch the server asked for, and imports after it", async () => {
    const { x, calls } = fakeRunner();
    const attempts: string[] = [];
    const result = await runHourly(x, {
      ...HOURLY,
      santanderFetch: { mode: "payday", reason: "payday (2026-09-30)" },
      onSantanderAttempt: (mode) => void attempts.push(mode),
    });
    expect(attempts).toEqual(["payday"]);
    expect(result).toEqual({ santander: { mode: "payday", outcome: "ok", note: null }, activity: true });
    expect(calls.slice(6)).toEqual([
      "run fetch:santander -- --background --movements-only",
      "run import:santander-movements",
      "run import:checking-usd-movements",
      "run convert:cc-payment-mirrors",
      "run check:cc-bank-cupo",
      "run import:cfraser-inbox",
      "run import:transfer-mails -- --days=2",
      "run import:fintual-wallet -- --apply",
    ]);
  });

  it("declines a requested fetch it cannot safely make", async () => {
    const { x, calls, notes } = fakeRunner();
    const attempts: string[] = [];
    const result = await runHourly(x, {
      ...HOURLY,
      santanderFetch: { mode: "catch-up", reason: "no fetch since the 22:00 slot" },
      santanderVeto: () => "login latched off after a credentials rejection",
      onSantanderAttempt: (mode) => void attempts.push(mode),
    });
    expect(attempts).toEqual([]);
    expect(result.santander).toEqual({
      mode: "catch-up",
      outcome: "vetoed",
      note: "login latched off after a credentials rejection",
    });
    expect(calls.some((c) => c.includes("fetch:santander --"))).toBe(false);
    expect(notes).toContain("=== Santander catch-up (declined — login latched off after a credentials rejection)");
  });
});

describe("output counts", () => {
  it("reads the last summary line of a fetch", () => {
    expect(savedCount("Summary: 1 saved, 2 skipped\n…\nSummary: 3 saved, 0 skipped")).toBe(3);
    expect(savedCount("no summary")).toBe(0);
    expect(brokerMessageCount("[10:30:00] e-mail: 4 broker message(s)")).toBe(4);
  });
});

describe("santanderVeto", () => {
  const now = new Date("2026-09-30T15:00:00Z");
  const markers = { last_catch_up_attempt_at: null, last_payday_attempt_ymd: null };
  it("declines when latched or tried less than 35 min ago", () => {
    expect(santanderVeto({ last_attempt_at: null, last_success_at: null, login_latched: true, ...markers }, now)).toMatch(/latched/);
    expect(
      santanderVeto({ last_attempt_at: "2026-09-30T14:40:00.000Z", last_success_at: null, login_latched: false, ...markers }, now)
    ).toBe("last attempt 20 min ago — waiting 35 min");
    expect(santanderVeto({ last_attempt_at: "2026-09-30T14:20:00.000Z", last_success_at: null, login_latched: false, ...markers }, now)).toBeNull();
  });
});

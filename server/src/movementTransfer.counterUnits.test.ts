import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getMergedDepositInflowEventsForAccount } from "./accountDeposits.js";
import { accountRowForId } from "./accountRowForMovement.js";
import { db } from "./db.js";
import { FLOW_KIND_AFP_FUND_SWITCH } from "./movementFlowType.js";
import {
  transferFromLegUnits,
  transferLegUnitsThroughDate,
  transferToLegUnits,
} from "./movementTransfer.js";
import { accountTakesUnits, validateMovementCreate } from "./movementUnitsPolicy.js";

/**
 * A transfer between two cuota accounts (an AFP fund switch) carries two counts: the cuotas
 * sold on the from-leg (`units_delta`) and the cuotas bought on the to-leg
 * (`counter_units_delta`). Synthetic AFP accounts in the afp leaf group plus a checking one.
 */

const NOTE = "vitest-counter-units";
let afpFrom = 0;
let afpTo = 0;
let checking = 0;

beforeAll(() => {
  const afpGroup = db
    .prepare(`SELECT id FROM asset_groups WHERE slug LIKE '%\\_\\_afp' ESCAPE '\\' LIMIT 1`)
    .get() as { id: number } | undefined;
  const checkingGroup = db
    .prepare(`SELECT id FROM asset_groups WHERE slug LIKE '%cuenta_corriente' LIMIT 1`)
    .get() as { id: number } | undefined;
  if (!afpGroup || !checkingGroup) return;
  const ins = db.prepare(`INSERT INTO accounts (asset_group_id, name) VALUES (?, ?)`);
  afpFrom = Number(ins.run(afpGroup.id, "vitest-counter-units PlanVital A").lastInsertRowid);
  afpTo = Number(ins.run(afpGroup.id, "vitest-counter-units Modelo A").lastInsertRowid);
  checking = Number(ins.run(checkingGroup.id, "vitest-counter-units checking").lastInsertRowid);
});

afterAll(() => {
  db.prepare(`DELETE FROM movements WHERE note = ?`).run(NOTE);
  for (const id of [afpFrom, afpTo, checking]) {
    if (id) db.prepare(`DELETE FROM accounts WHERE id = ?`).run(id);
  }
});

function insertSwitch(unitsSold: number, unitsBought: number | null, occurredOn = "1990-06-01"): number {
  return Number(
    db
      .prepare(
        `INSERT INTO movements (account_id, from_account_id, to_account_id, amount, currency, occurred_on,
                                note, units_delta, counter_units_delta, flow_kind)
         VALUES (NULL, ?, ?, 1000000, 'clp', ?, ?, ?, ?, ?)`
      )
      .run(afpFrom, afpTo, occurredOn, NOTE, unitsSold, unitsBought, FLOW_KIND_AFP_FUND_SWITCH).lastInsertRowid
  );
}

describe("transfer leg units with a counter", () => {
  it("reads the to-leg's own count and the from-leg's units_delta", () => {
    const row = { units_delta: 40.8, counter_units_delta: 38.41 };
    expect(transferToLegUnits(row)).toBe(38.41);
    expect(transferFromLegUnits(row)).toBe(40.8);
    // Every existing transfer: no counter, both legs share one count.
    expect(transferToLegUnits({ units_delta: 7, counter_units_delta: null })).toBe(7);
    expect(transferToLegUnits({ units_delta: 7 })).toBe(7);
  });

  it("transferLegUnitsThroughDate: the sender loses what it sold, the receiver gains what it bought", () => {
    if (!afpFrom) return;
    const id = insertSwitch(40.8, 38.41);
    expect(transferLegUnitsThroughDate(afpFrom, "1990-12-31")).toBeCloseTo(-40.8, 9);
    expect(transferLegUnitsThroughDate(afpTo, "1990-12-31")).toBeCloseTo(38.41, 9);
    // Before the switch day neither side has moved.
    expect(transferLegUnitsThroughDate(afpFrom, "1990-05-31")).toBe(0);
    expect(transferLegUnitsThroughDate(afpTo, "1990-05-31")).toBe(0);
    db.prepare(`DELETE FROM movements WHERE id = ?`).run(id);
  });

  it("a transfer without a counter still credits the to-leg its units_delta", () => {
    if (!afpFrom) return;
    const id = insertSwitch(12.5, null);
    expect(transferLegUnitsThroughDate(afpFrom, "1990-12-31")).toBeCloseTo(-12.5, 9);
    expect(transferLegUnitsThroughDate(afpTo, "1990-12-31")).toBeCloseTo(12.5, 9);
    db.prepare(`DELETE FROM movements WHERE id = ?`).run(id);
  });

  it("an update of counter_units_delta logs both legs' accounts for the mark cache", () => {
    if (!afpFrom) return;
    const id = insertSwitch(40.8, null);
    const before = (db.prepare(`SELECT COALESCE(MAX(id), 0) AS id FROM mark_input_changes`).get() as { id: number }).id;
    db.prepare(`UPDATE movements SET counter_units_delta = 38.41 WHERE id = ?`).run(id);
    const logged = db
      .prepare(`SELECT account_id FROM mark_input_changes WHERE id > ? AND source = 'movements'`)
      .all(before) as { account_id: number | null }[];
    const accounts = new Set(logged.map((r) => r.account_id));
    expect(accounts).toEqual(new Set([afpFrom, afpTo]));
    db.prepare(`DELETE FROM movements WHERE id = ?`).run(id);
  });
});

describe("a fund switch's flow events", () => {
  it("are ordinary transfer legs: a withdrawal from the sender, a deposit into the receiver", () => {
    if (!afpFrom) return;
    const id = insertSwitch(40.8, 38.41);
    const sender = getMergedDepositInflowEventsForAccount(afpFrom).filter((e) => e.occurred_on === "1990-06-01");
    const receiver = getMergedDepositInflowEventsForAccount(afpTo).filter((e) => e.occurred_on === "1990-06-01");
    expect(sender.map((e) => e.amt)).toEqual([-1000000]);
    expect(receiver.map((e) => e.amt)).toEqual([1000000]);
    db.prepare(`DELETE FROM movements WHERE id = ?`).run(id);
  });
});

describe("counter_units_delta on movement creates", () => {
  const switchBody = (over: Record<string, unknown>) => ({
    counterpart_account_id: afpTo,
    counterpart_role: "to",
    occurred_on: "1990-06-01", // before any valor cuota, so the CLP/cuota reconcile has no price to check
    amount: 1000000,
    currency: "clp",
    units_delta: 40.8,
    counter_units_delta: 38.41,
    flow_kind: FLOW_KIND_AFP_FUND_SWITCH,
    note: NOTE,
    ...over,
  });

  it("names which accounts take units", () => {
    if (!afpFrom) return;
    expect(accountTakesUnits(accountRowForId(afpFrom)!)).toBe(true);
    expect(accountTakesUnits(accountRowForId(checking)!)).toBe(false);
  });

  it("accepts it on a transfer between two cuota accounts carrying units_delta", () => {
    if (!afpFrom) return;
    const v = validateMovementCreate(accountRowForId(afpFrom)!, switchBody({}), afpFrom);
    expect(v.ok).toBe(true);
    if (!v.ok || v.mode !== "transfer") throw new Error("expected a transfer");
    expect(v.from_account_id).toBe(afpFrom);
    expect(v.to_account_id).toBe(afpTo);
    expect(v.units_delta).toBe(40.8);
    expect(v.counter_units_delta).toBe(38.41);
    expect(v.flow_kind).toBe(FLOW_KIND_AFP_FUND_SWITCH);
  });

  it("refuses it on a single-leg row", () => {
    if (!afpFrom) return;
    const v = validateMovementCreate(
      accountRowForId(afpFrom)!,
      { occurred_on: "1990-06-01", amount: 1000000, currency: "clp", units_delta: 40.8, counter_units_delta: 38.41 },
      afpFrom
    );
    expect(v.ok).toBe(false);
    if (v.ok) return;
    expect(v.error).toMatch(/counter_units_delta is only supported on a transfer/);
    const cash = validateMovementCreate(
      accountRowForId(checking)!,
      { occurred_on: "1990-06-01", amount: 1000, currency: "clp", flow_kind: "deposit_clp", counter_units_delta: 1 },
      checking
    );
    expect(cash.ok).toBe(false);
    if (cash.ok) return;
    expect(cash.error).toMatch(/counter_units_delta is only supported on a transfer/);
  });

  it("refuses it on a transfer without units_delta", () => {
    if (!afpFrom) return;
    const v = validateMovementCreate(
      accountRowForId(checking)!,
      switchBody({ counterpart_account_id: afpTo, units_delta: null, flow_kind: null }),
      checking
    );
    expect(v.ok).toBe(false);
    if (v.ok) return;
    expect(v.error).toMatch(/counter_units_delta requires units_delta/);
  });

  it("refuses it when the to-leg account takes no units", () => {
    if (!afpFrom) return;
    const v = validateMovementCreate(
      accountRowForId(afpFrom)!,
      switchBody({ counterpart_account_id: checking }),
      afpFrom
    );
    expect(v.ok).toBe(false);
    if (v.ok) return;
    expect(v.error).toMatch(new RegExp(`to-leg account ${checking} takes no units`));
  });

  it("refuses a zero counter", () => {
    if (!afpFrom) return;
    const v = validateMovementCreate(accountRowForId(afpFrom)!, switchBody({ counter_units_delta: 0 }), afpFrom);
    expect(v.ok).toBe(false);
    if (v.ok) return;
    expect(v.error).toMatch(/counter_units_delta must be a non-zero number/);
  });
});

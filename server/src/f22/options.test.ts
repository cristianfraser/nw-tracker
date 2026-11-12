import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db } from "../db.js";
import { buildF22Draft } from "./draft.js";
import type { ForeignFxDisposalLoader } from "./foreignFx.js";

// Synthetic far years no other suite reaches.
const NR_YEAR = 2089; // a declared US-resident year (non-resident of Chile)
const RES_YEAR = 2091; // undeclared: a Chilean-resident year
const OBSERVADO = 900;
const NOTE = "vitest-f22-options";
const noUsd: ForeignFxDisposalLoader = () => ({ disposals: [], openLots: [] });
const accounts: number[] = [];

function account(name: string): number {
  const id = Number(
    db.prepare(`INSERT INTO accounts (name, asset_group_id) VALUES (?, (SELECT id FROM asset_groups LIMIT 1))`).run(`${NOTE} ${name}`).lastInsertRowid
  );
  accounts.push(id);
  return id;
}

function premium(contract: number, cash: number, day: string, kind: string, amount: number, contracts: number) {
  const received = kind === "option_sell_open" || kind === "option_sell_close";
  db.prepare(
    `INSERT INTO movements (from_account_id, to_account_id, amount, currency, occurred_on, note, flow_kind, units_delta) VALUES (?, ?, ?, 'usd', ?, ?, ?, ?)`
  ).run(received ? contract : cash, received ? cash : contract, amount, day, NOTE, kind, contracts);
}

describe("options on the F22", () => {
  beforeAll(() => {
    const contract = account("contract");
    const cash = account("cash");
    premium(contract, cash, `${NR_YEAR}-02-03`, "option_sell_open", 300, 2);
    premium(contract, cash, `${NR_YEAR}-03-03`, "option_buy_close", 120, 2);
    premium(contract, cash, `${RES_YEAR}-02-03`, "option_sell_open", 200, 1);
    db.prepare(`INSERT INTO fx_daily_bcentral (date, clp_per_usd) VALUES (?, ?)`).run(`${NR_YEAR}-12-15`, OBSERVADO);
    db.prepare(`INSERT INTO fx_daily_bcentral (date, clp_per_usd) VALUES (?, ?)`).run(`${RES_YEAR}-12-15`, OBSERVADO);
    db.prepare(`INSERT INTO tax_residency_periods (jurisdiction, from_date, to_date, note) VALUES ('us', ?, ?, ?)`).run(`${NR_YEAR}-01-01`, `${NR_YEAR}-12-31`, NOTE);
  });

  afterAll(() => {
    db.prepare(`DELETE FROM tax_residency_periods WHERE note = ?`).run(NOTE);
    db.prepare(`DELETE FROM movements WHERE note = ?`).run(NOTE);
    db.prepare(`DELETE FROM fx_daily_bcentral WHERE date IN (?, ?)`).run(`${NR_YEAR}-12-15`, `${RES_YEAR}-12-15`);
    for (const id of accounts) db.prepare(`DELETE FROM accounts WHERE id = ?`).run(id);
  });

  it("throws on an option movement inside a Chilean-resident window (Ley 20.544 not modelled)", () => {
    expect(() => buildF22Draft(RES_YEAR + 1, `${RES_YEAR}-12-15`, { foreignFx: { load: noUsd } })).toThrow(/1 option movement\(s\) inside the resident window .* Ley 20\.544 are not modelled/);
  });

  it("lists a non-resident window's option movements as one excluded item: their count and the net premium", () => {
    const d = buildF22Draft(NR_YEAR + 1, `${NR_YEAR}-12-15`, { foreignFx: { load: noUsd } });
    expect(d.regime).toBe("nonresident");
    const item = d.excluded.find((x) => x.kind === "options");
    expect(item).toMatchObject({ kind: "options", reason: "nonresident", count: 2, clp: (300 - 120) * OBSERVADO });
  });
});

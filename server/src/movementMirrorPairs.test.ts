import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { db } from "./db.js";
import { listMirrorPairCandidates, type MirrorPairCandidate } from "./movementMirrorPairs.js";

const NOTE = "vitest-mirror-pairs";

/** Unique odd amounts so fixture legs can never pair with real rows in a copied dev DB. */
const AMT = {
  basic: 7_654_321,
  ambiguous: 8_881_113,
  window: 9_192_939,
  midweek: 6_060_601,
  straddle: 5_151_517,
  straddleChk: 4_242_437,
  units: 3_939_397,
  bothUnits: 2_828_283,
  flowKind: 1_717_171,
  usd: 1_616_161,
  linked: 1_515_151,
  dap: 1_414_141,
  afc: 1_313_131,
  rejected: 1_212_121,
} as const;

const ACCT = {
  generic: "vitest-mirror-generic",
  generic2: "vitest-mirror-generic2",
  checking: "vitest-mirror-checking",
  vista: "vitest-mirror-vista",
  dap: "vitest-mirror-dap",
  afc: "vitest-mirror-afc",
  fund: "vitest-mirror-fund",
  fund2: "vitest-mirror-fund2",
} as const;

let ids: Record<keyof typeof ACCT, number>;

function groupId(slugLike: string): number | undefined {
  // `_` is a LIKE wildcard; escape it so `%\_\_afc` can't match the parent hub `retirement_afp_afc`.
  const escaped = slugLike.replace(/_/g, "\\_");
  return (db
    .prepare(`SELECT id FROM asset_groups WHERE slug LIKE ? ESCAPE '\\' LIMIT 1`)
    .get(escaped) as { id: number } | undefined)?.id;
}

function insLeg(accountId: number, amount: number, ymd: string, units: number | null = null, note = NOTE): number {
  return Number(
    db
      .prepare(
        `INSERT INTO movements (account_id, amount_clp, occurred_on, units_delta, note) VALUES (?,?,?,?,?)`
      )
      .run(accountId, amount, ymd, units, note).lastInsertRowid
  );
}

function pairFor(pairs: MirrorPairCandidate[], outId: number): MirrorPairCandidate | undefined {
  return pairs.find((p) => p.out.movement_id === outId);
}

function cleanup() {
  db.prepare(`DELETE FROM movement_mirror_pair_rejections WHERE out_movement_id IN (
    SELECT id FROM movements WHERE note LIKE 'vitest-mirror%')`).run();
  db.prepare(`DELETE FROM expense_deposit_links WHERE purchase_key = 'vitest-mirror-link'`).run();
  db.prepare(`DELETE FROM movements WHERE note LIKE 'vitest-mirror%'`).run();
  db.prepare(`DELETE FROM accounts WHERE name LIKE 'vitest-mirror-%'`).run();
}

describe("listMirrorPairCandidates", () => {
  beforeAll(() => {
    cleanup();
    const anyLeaf = groupId("%")!;
    const cc = groupId("%__cuenta_corriente") ?? anyLeaf;
    const vista = groupId("%__cuenta_vista") ?? anyLeaf;
    const dap = groupId("%__dap") ?? anyLeaf;
    const afc = groupId("%__afc") ?? anyLeaf;
    const ins = db.prepare(`INSERT INTO accounts (asset_group_id, name) VALUES (?, ?)`);
    ids = {
      generic: Number(ins.run(anyLeaf, ACCT.generic).lastInsertRowid),
      generic2: Number(ins.run(anyLeaf, ACCT.generic2).lastInsertRowid),
      checking: Number(ins.run(cc, ACCT.checking).lastInsertRowid),
      vista: Number(ins.run(vista, ACCT.vista).lastInsertRowid),
      dap: Number(ins.run(dap, ACCT.dap).lastInsertRowid),
      afc: Number(ins.run(afc, ACCT.afc).lastInsertRowid),
      fund: Number(ins.run(anyLeaf, ACCT.fund).lastInsertRowid),
      fund2: Number(ins.run(anyLeaf, ACCT.fund2).lastInsertRowid),
    };
  });

  afterAll(cleanup);

  it("finds a basic same-day pair as high confidence", () => {
    const out = insLeg(ids.generic, -AMT.basic, "2026-03-10");
    insLeg(ids.generic2, AMT.basic, "2026-03-10");
    const p = pairFor(listMirrorPairCandidates(), out);
    expect(p).toBeDefined();
    expect(p!.confidence).toBe("high");
    expect(p!.gap_days).toBe(0);
    expect(p!.within_business_day_window).toBe(true);
    expect(p!.month_straddle).toBe(false);
    expect(p!.blocked).toBe(false);
  });

  it("never pairs an inflow dated before the outflow", () => {
    const out = insLeg(ids.generic, -1_010_107, "2026-03-12");
    insLeg(ids.generic2, 1_010_107, "2026-03-11");
    expect(pairFor(listMirrorPairCandidates(), out)).toBeUndefined();
  });

  it("two same-amount inflows make the pair ambiguous with candidate counts", () => {
    const out = insLeg(ids.generic, -AMT.ambiguous, "2026-03-15");
    insLeg(ids.generic2, AMT.ambiguous, "2026-03-15");
    insLeg(ids.checking, AMT.ambiguous, "2026-03-16");
    const p = pairFor(listMirrorPairCandidates(), out);
    expect(p).toBeDefined();
    expect(p!.out_candidate_count).toBe(2);
    expect(p!.confidence).toBe("ambiguous");
  });

  it("Fri→Mon is within the business-day window (high); a 3-day midweek gap is not", () => {
    const fri = insLeg(ids.generic, -AMT.window, "2026-07-03");
    insLeg(ids.generic2, AMT.window, "2026-07-06");
    const tue = insLeg(ids.generic, -AMT.midweek, "2026-06-02");
    insLeg(ids.generic2, AMT.midweek, "2026-06-05");
    const pairs = listMirrorPairCandidates();
    expect(pairFor(pairs, fri)!.within_business_day_window).toBe(true);
    expect(pairFor(pairs, fri)!.confidence).toBe("high");
    expect(pairFor(pairs, tue)!.within_business_day_window).toBe(false);
    expect(pairFor(pairs, tue)!.confidence).toBe("ambiguous");
  });

  it("month straddle is ambiguous; blocked when the inflow lands on checking", () => {
    const plain = insLeg(ids.generic, -AMT.straddle, "2026-01-30");
    insLeg(ids.generic2, AMT.straddle, "2026-02-02");
    const chk = insLeg(ids.generic, -AMT.straddleChk, "2026-01-30");
    insLeg(ids.checking, AMT.straddleChk, "2026-02-02");
    const pairs = listMirrorPairCandidates();
    const pPlain = pairFor(pairs, plain)!;
    expect(pPlain.month_straddle).toBe(true);
    expect(pPlain.confidence).toBe("ambiguous");
    expect(pPlain.blocked).toBe(false);
    const pChk = pairFor(pairs, chk)!;
    expect(pChk.blocked).toBe(true);
    expect(pChk.blocked_reason).toBe("checking_inflow_month_straddle");
  });

  it("corriente↔vista pairs are eligible", () => {
    const out = insLeg(ids.checking, -2_121_211, "2026-03-20");
    insLeg(ids.vista, 2_121_211, "2026-03-20");
    const p = pairFor(listMirrorPairCandidates(), out);
    expect(p).toBeDefined();
    expect(p!.confidence).toBe("high");
  });

  it("a fund leg with cuotas pairs (units on one leg only); both-legs-units is excluded", () => {
    const retiro = insLeg(ids.fund, -AMT.units, "2026-03-22", -12.345678);
    insLeg(ids.checking, AMT.units, "2026-03-23");
    const bothOut = insLeg(ids.fund, -AMT.bothUnits, "2026-03-24", -5);
    insLeg(ids.fund2, AMT.bothUnits, "2026-03-24", 4.2);
    const pairs = listMirrorPairCandidates();
    const p = pairFor(pairs, retiro);
    expect(p).toBeDefined();
    expect(p!.out.units_delta).toBeCloseTo(-12.345678);
    expect(pairFor(pairs, bothOut)).toBeUndefined();
  });

  it("excludes flow_kind legs, amount_usd legs, dap accounts, and afc inflows", () => {
    const fk = Number(
      db
        .prepare(
          `INSERT INTO movements (account_id, amount_clp, occurred_on, flow_kind, note) VALUES (?,?,?,?,?)`
        )
        .run(ids.generic, -AMT.flowKind, "2026-03-25", "withdrawal_clp", NOTE).lastInsertRowid
    );
    insLeg(ids.generic2, AMT.flowKind, "2026-03-25");
    const usd = Number(
      db
        .prepare(
          `INSERT INTO movements (account_id, amount_clp, occurred_on, amount_usd, note) VALUES (?,?,?,?,?)`
        )
        .run(ids.generic, -AMT.usd, "2026-03-26", 1700, NOTE).lastInsertRowid
    );
    insLeg(ids.generic2, AMT.usd, "2026-03-26");
    const dapOut = insLeg(ids.dap, -AMT.dap, "2026-03-27");
    insLeg(ids.generic2, AMT.dap, "2026-03-27");
    const afcIn = insLeg(ids.generic, -AMT.afc, "2026-03-28");
    insLeg(ids.afc, AMT.afc, "2026-03-28");
    const pairs = listMirrorPairCandidates();
    expect(pairFor(pairs, fk)).toBeUndefined();
    expect(pairFor(pairs, usd)).toBeUndefined();
    expect(pairFor(pairs, dapOut)).toBeUndefined();
    expect(pairFor(pairs, afcIn)).toBeUndefined();
  });

  it("afc outflows stay eligible (the canonical AFC → checking retiro)", () => {
    const out = insLeg(ids.afc, -2_772_871, "2026-06-10");
    insLeg(ids.checking, 2_772_871, "2026-06-11");
    const p = pairFor(listMirrorPairCandidates(), out);
    expect(p).toBeDefined();
    expect(p!.confidence).toBe("high");
  });

  it("a deposit already in expense_deposit_links is not a candidate", () => {
    const out = insLeg(ids.generic, -AMT.linked, "2026-03-30");
    const dep = insLeg(ids.generic2, AMT.linked, "2026-03-30");
    db.prepare(
      `INSERT INTO expense_deposit_links (account_id, purchase_key, deposit_movement_id, payment_clp, amortization_clp, link_source)
       VALUES (?, 'vitest-mirror-link', ?, ?, 0, 'auto')`
    ).run(ids.generic2, dep, AMT.linked);
    expect(pairFor(listMirrorPairCandidates(), out)).toBeUndefined();
  });

  it("a rejection hides the pair permanently and frees the legs for other partners", () => {
    const out = insLeg(ids.generic, -AMT.rejected, "2026-04-02");
    const dep = insLeg(ids.generic2, AMT.rejected, "2026-04-02");
    expect(pairFor(listMirrorPairCandidates(), out)).toBeDefined();
    db.prepare(
      `INSERT INTO movement_mirror_pair_rejections (out_movement_id, in_movement_id) VALUES (?, ?)`
    ).run(out, dep);
    expect(pairFor(listMirrorPairCandidates(), out)).toBeUndefined();
    // A different inflow of the same amount can still claim the outflow.
    insLeg(ids.checking, AMT.rejected, "2026-04-03");
    const p = pairFor(listMirrorPairCandidates(), out);
    expect(p).toBeDefined();
    expect(p!.in.account_id).toBe(ids.checking);
  });
});

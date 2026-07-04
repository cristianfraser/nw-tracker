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
  ahorro: "vitest-mirror-ahorro",
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
      ahorro: Number(
        ins.run(groupId("%__cuenta_ahorro_vivienda") ?? anyLeaf, ACCT.ahorro).lastInsertRowid
      ),
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

  it("a payroll-linked deposit (payroll_work_earnings) is not a candidate", () => {
    const out = insLeg(ids.generic, -1_919_193, "2026-03-29");
    const dep = insLeg(ids.checking, 1_919_193, "2026-03-29");
    db.prepare(
      `INSERT INTO payroll_work_earnings (period_month, employer_name, liquido, liquido_currency, source_pdf, movement_id)
       VALUES ('2026-03', 'vitest-mirror-employer', 1919193, 'clp', 'vitest-mirror.pdf', ?)`
    ).run(dep);
    try {
      expect(pairFor(listMirrorPairCandidates(), out)).toBeUndefined();
    } finally {
      db.prepare(`DELETE FROM payroll_work_earnings WHERE employer_name = 'vitest-mirror-employer'`).run();
    }
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

  describe("cuenta de ahorro month-precision", () => {
    it("deposit dated month-end pairs with a checking outflow anywhere in that month (high)", () => {
      const out = insLeg(ids.checking, -4_141_147, "2026-08-05");
      insLeg(ids.ahorro, 4_141_147, "2026-08-31");
      const p = pairFor(listMirrorPairCandidates(), out);
      expect(p).toBeDefined();
      expect(p!.month_precision).toBe(true);
      expect(p!.month_straddle).toBe(false);
      expect(p!.confidence).toBe("high");
    });

    it("also pairs with an outflow in the last week of the previous month (ambiguous, straddle)", () => {
      const out = insLeg(ids.checking, -4_242_449, "2026-08-28");
      insLeg(ids.ahorro, 4_242_449, "2026-09-30");
      const p = pairFor(listMirrorPairCandidates(), out);
      expect(p).toBeDefined();
      expect(p!.month_precision).toBe(true);
      expect(p!.month_straddle).toBe(true);
      expect(p!.confidence).toBe("ambiguous");
      expect(p!.blocked).toBe(false);
    });

    it("does not pair with a mid-previous-month or next-month outflow", () => {
      const mid = insLeg(ids.checking, -4_343_441, "2026-09-15");
      insLeg(ids.ahorro, 4_343_441, "2026-10-31");
      const next = insLeg(ids.checking, -4_444_443, "2026-12-01");
      insLeg(ids.ahorro, 4_444_443, "2026-11-30");
      const pairs = listMirrorPairCandidates();
      expect(pairFor(pairs, mid)).toBeUndefined();
      expect(pairFor(pairs, next)).toBeUndefined();
    });

    it("an ahorro retiro (month-end out) pairs with a checking inflow earlier that month", () => {
      const out = insLeg(ids.ahorro, -4_545_447, "2026-07-31");
      insLeg(ids.checking, 4_545_447, "2026-07-10");
      const p = pairFor(listMirrorPairCandidates(), out);
      expect(p).toBeDefined();
      expect(p!.month_precision).toBe(true);
      expect(p!.confidence).toBe("high");
      // transfer will keep the checking (real-day) date, so no checking-straddle block applies
      expect(p!.blocked).toBe(false);
    });
  });

  describe("link-established pairs (expense_deposit_links)", () => {
    const key = () => `checking-cartola:${ids.checking}:2026-05:2026-05-12:-6161617:0`;
    const cartolaNote = "import:cartola|2026-05|Ag|Transf a fondo|on:2026-05-12|amt:-6161617|idx:0";

    function cleanupLinks() {
      db.prepare(`DELETE FROM expense_deposit_links WHERE purchase_key LIKE ?`).run(
        `checking-cartola:${ids.checking}:%`
      );
    }

    it("a 1:1 auto link becomes a high-confidence linked candidate; conversion cascades the link", () => {
      cleanupLinks();
      const out = insLeg(ids.checking, -6_161_617, "2026-05-12", null, cartolaNote);
      const dep = insLeg(ids.fund, 6_161_617, "2026-05-14", 3.21, NOTE);
      db.prepare(
        `INSERT INTO expense_deposit_links (account_id, purchase_key, deposit_movement_id, payment_clp, amortization_clp, link_source)
         VALUES (?, ?, ?, 6161617, 0, 'auto')`
      ).run(ids.fund, key(), dep);
      try {
        const p = pairFor(listMirrorPairCandidates(), out);
        expect(p).toBeDefined();
        expect(p!.linked).toBe(true);
        expect(p!.confidence).toBe("high");
        expect(p!.in.movement_id).toBe(dep);
      } finally {
        cleanupLinks();
      }
    });

    it("multi-deposit links and amount mismatches are not linked candidates", () => {
      cleanupLinks();
      const out = insLeg(ids.checking, -7_171_717, "2026-05-20", null,
        "import:cartola|2026-05|Ag|Transf|on:2026-05-20|amt:-7171717|idx:0");
      const multiKey = `checking-cartola:${ids.checking}:2026-05:2026-05-20:-7171717:0`;
      const depA = insLeg(ids.fund, 4_000_000, "2026-05-21", null, NOTE);
      const depB = insLeg(ids.fund2, 3_171_717, "2026-05-21", null, NOTE);
      const ins = db.prepare(
        `INSERT INTO expense_deposit_links (account_id, purchase_key, deposit_movement_id, payment_clp, amortization_clp, link_source)
         VALUES (?, ?, ?, ?, 0, 'auto')`
      );
      ins.run(ids.fund, multiKey, depA, 4_000_000);
      ins.run(ids.fund2, multiKey, depB, 3_171_717);
      try {
        // Two deposits on one outflow: no 1:1 transfer representation.
        expect(pairFor(listMirrorPairCandidates(), out)).toBeUndefined();
      } finally {
        cleanupLinks();
      }
    });
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

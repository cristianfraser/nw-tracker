import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db } from "./db.js";
import {
  isPendingAuthorizationOf,
  isTruncatedMerchantOf,
  planTruncatedMerchantDuplicateLines,
  removeTruncatedMerchantDuplicateLines,
  WEB_PASTE_MERCHANT_TRUNCATION_WIDTH,
} from "./ccTruncatedMerchantDedupe.js";
import {
  ensureVitestCreditCardFixtures,
  getVitestSantanderCcMasterAccountId,
  wipeVitestCcFixtureData,
} from "./test/vitestDbSeed.js";

describe("isTruncatedMerchantOf", () => {
  it("matches the real Santander web-table truncations", () => {
    // Both observed 2026-08-06 in the open bucket alongside their full twins.
    expect(isTruncatedMerchantOf("MERPAGO*PLANOUT", "MERPAGO*PLANOUTCANALDEVEN")).toBe(true);
    expect(isTruncatedMerchantOf("ANTHROPIC* CLAU", "ANTHROPIC* CLAUDE SUB")).toBe(true);
    expect("MERPAGO*PLANOUT".length).toBe(WEB_PASTE_MERCHANT_TRUNCATION_WIDTH);
  });

  it("matches the feed's 15-char pending-authorization rows (2026-09-05)", () => {
    // The nightly feed renders a pending authorization at the same 15-char cut as the web
    // table; the settled row carries the full name, with the terminal code spaced or glued.
    expect(isTruncatedMerchantOf("FARMACITY LA PL", "FARMACITY LA PLATA 2 4584")).toBe(true);
    expect(isTruncatedMerchantOf("LA GUITARRITA C", "LA GUITARRITA CABALLI5080")).toBe(true);
    expect(isTruncatedMerchantOf("AV. RIVADAVIA 4", "AV. RIVADAVIA 4715")).toBe(true);
  });

  it("is case- and whitespace-insensitive", () => {
    expect(isTruncatedMerchantOf("anthropic* clau", "ANTHROPIC*  CLAUDE SUB")).toBe(true);
  });

  it("does not match identical merchants", () => {
    // Two genuine charges of the same amount on nearby days must survive — the one-shot key
    // already handles true duplicates, and deleting here would destroy real spending.
    expect(isTruncatedMerchantOf("APPLE.COM/BILL", "APPLE.COM/BILL")).toBe(false);
    expect(isTruncatedMerchantOf("MERPAGO*PLANOUT", "MERPAGO*PLANOUT")).toBe(false);
  });

  it("requires the shorter string to be exactly at the truncation width", () => {
    // A merchant that is genuinely short and happens to prefix another one is NOT a truncation.
    expect(isTruncatedMerchantOf("APPLE.COM", "APPLE.COM/BILL")).toBe(false);
    expect(isTruncatedMerchantOf("RENDER.COM", "RENDER.COM SERVICES")).toBe(false);
    // 16 chars — past the web table's cut, so it was never truncated.
    expect(isTruncatedMerchantOf("ALMACENES BILBAO", "ALMACENES BILBAO SUR")).toBe(false);
  });

  it("requires a strict prefix, not merely a shared start", () => {
    expect(isTruncatedMerchantOf("ANTHROPIC* CLAU", "ANTHROPIC* XLAUDE SUB")).toBe(false);
    // The full string must actually be longer.
    expect(isTruncatedMerchantOf("ANTHROPIC* CLAU", "ANTHROPIC* CLA")).toBe(false);
  });

  it("tolerates blank merchants without matching", () => {
    expect(isTruncatedMerchantOf("", "ANYTHING AT ALL")).toBe(false);
    expect(isTruncatedMerchantOf("ANTHROPIC* CLAU", "")).toBe(false);
  });
});

describe("isPendingAuthorizationOf", () => {
  it("matches the six pending → settled pairs found on 2026-09-05", () => {
    expect(isPendingAuthorizationOf("SUPERCOOP F", "SUPERCOOP F 5067")).toBe(true);
    expect(isPendingAuthorizationOf("CHANA", "CHANA 7142")).toBe(true);
    expect(isPendingAuthorizationOf("TRGS", "TRGS 4551")).toBe(true);
    expect(isPendingAuthorizationOf("EMOVA SUBTE", "EMOVA SUBTE 4042")).toBe(true);
    // The clearing name may carry extra words before the code.
    expect(isPendingAuthorizationOf("BISONTE PALACE", "BISONTE PALACE HOTEL 4995")).toBe(true);
  });

  it("is case- and whitespace-insensitive", () => {
    expect(isPendingAuthorizationOf("chana", "CHANA  7142")).toBe(true);
    expect(isPendingAuthorizationOf(" EMOVA SUBTE ", "EMOVA SUBTE 4042")).toBe(true);
  });

  it("does not match identical merchants", () => {
    // The feed's APPLE.COM/BILL pending rows restate with the SAME merchant a day later — that
    // pair is deliberately not ours (it self-resolves at the facturación).
    expect(isPendingAuthorizationOf("APPLE.COM/BILL", "APPLE.COM/BILL")).toBe(false);
    expect(isPendingAuthorizationOf("CHANA 7142", "CHANA 7142")).toBe(false);
  });

  it("requires the settled row to end in a spaced 4-digit terminal code", () => {
    expect(isPendingAuthorizationOf("CHANA", "CHANA")).toBe(false);
    expect(isPendingAuthorizationOf("CHANA", "CHANA 714")).toBe(false);
    expect(isPendingAuthorizationOf("CHANA", "CHANA 71425")).toBe(false);
    expect(isPendingAuthorizationOf("CHANA", "CHANA 7142 X")).toBe(false);
    // Glued code (bank's 25-char overflow) — that name was cut at 15 pending, i.e. rule 1.
    expect(isPendingAuthorizationOf("LA GUITARRITA", "LA GUITARRITA CABALLI5080")).toBe(false);
    // A short name that merely prefixes a longer merchant without a code is real spending.
    expect(isPendingAuthorizationOf("APPLE.COM", "APPLE.COM/BILL")).toBe(false);
    expect(isPendingAuthorizationOf("OCULTO", "OCULTO BEERGARDEN")).toBe(false);
  });

  it("requires the pending name to be the settled core or a whole-word prefix of it", () => {
    expect(isPendingAuthorizationOf("BISONTE PAL", "BISONTE PALACE HOTEL 4995")).toBe(false);
    expect(isPendingAuthorizationOf("CHAN", "CHANA 7142")).toBe(false);
    expect(isPendingAuthorizationOf("CHANA", "CHANAX 7142")).toBe(false);
    expect(isPendingAuthorizationOf("TRGS", "TRGSA 4551")).toBe(false);
  });

  it("leaves names at or past the truncation width to rule 1", () => {
    // Exactly 15 — rule 1's domain (strict prefix at the cut).
    expect(isPendingAuthorizationOf("FARMACITY LA PL", "FARMACITY LA PL 4584")).toBe(false);
    expect(isTruncatedMerchantOf("FARMACITY LA PL", "FARMACITY LA PL 4584")).toBe(true);
    // Wider than the cut is never a pending rendering.
    expect(isPendingAuthorizationOf("BISONTE PALACE HOTEL", "BISONTE PALACE HOTEL 4995")).toBe(
      false
    );
  });

  it("tolerates blank merchants without matching", () => {
    expect(isPendingAuthorizationOf("", "CHANA 7142")).toBe(false);
    expect(isPendingAuthorizationOf("CHANA", "")).toBe(false);
  });
});

describe("removeTruncatedMerchantDuplicateLines (web-paste bucket)", () => {
  let accountId = 0;
  let statementId = 0;
  const ids: Record<string, number> = {};

  function insertLine(
    key: string,
    merchant: string,
    transactionDate: string,
    amount: { usd?: number; clp?: number }
  ): number {
    const r = db
      .prepare(
        `INSERT INTO cc_statement_lines (
           statement_id, transaction_date, merchant, amount_clp, amount_usd,
           installment_flag, dedupe_key, parser_row_id, raw_line
         ) VALUES (?, ?, ?, ?, ?, 0, ?, ?, 'vitest')`
      )
      .run(
        statementId,
        transactionDate,
        merchant,
        amount.clp ?? 0,
        amount.usd ?? null,
        `vitest-merchant-dedupe|${key}`,
        `vitest-merchant-dedupe|${key}`
      );
    const id = Number(r.lastInsertRowid);
    ids[key] = id;
    return id;
  }

  beforeAll(() => {
    ensureVitestCreditCardFixtures();
    const id = getVitestSantanderCcMasterAccountId();
    if (id == null) throw new Error("vitest CC fixture master missing (NW_TRACKER_TEST_DB unset?)");
    accountId = id;
    wipeVitestCcFixtureData();

    const r = db
      .prepare(
        `INSERT INTO cc_statements (
           account_id, card_group, source_pdf, statement_date, card_last4, layout, currency
         ) VALUES (?, 'santander', 'import:web-paste|open|2026-09', '20/09/2026', '0000', 'compact', 'clp')`
      )
      .run(accountId);
    statementId = Number(r.lastInsertRowid);

    // Rule 2: pending short name → settled name + terminal code (same date, same cents).
    insertLine("chana_pending", "VITEST CHANA", "30/8/2026", { usd: 136.89 });
    insertLine("chana_settled", "VITEST CHANA 7142", "30/8/2026", { usd: 136.89 });
    // Rule 2 with extra clearing-name words before the code.
    insertLine("bisonte_pending", "VITEST BISONTE", "2/9/2026", { usd: 41.52 });
    insertLine("bisonte_settled", "VITEST BISONTE HOTEL 4995", "2/9/2026", { usd: 41.52 });
    // Rule 1 still runs through the same pass (exactly 15 chars, strict prefix).
    insertLine("farmacity_pending", "VITEST FARMACIT", "29/8/2026", { usd: 20.63 });
    insertLine("farmacity_settled", "VITEST FARMACITY LA PLATA 4584", "29/8/2026", { usd: 20.63 });
    // A pending row whose settled twin has not arrived is the sole evidence — must survive.
    insertLine("trgs_pending_alone", "VITEST TRGS", "30/8/2026", { usd: 16.64 });
    // Identical merchants restated a day apart (the Apple pattern) — never ours.
    insertLine("apple_a", "VITEST APPLE", "30/8/2026", { usd: 18.96 });
    insertLine("apple_b", "VITEST APPLE", "31/8/2026", { usd: 18.96 });
    // Rule 2 is same-day only: the feed keeps the date when it settles, so a short-name row a
    // day later is a second ride, not the settled twin — it must survive every pass.
    insertLine("subte_pending_1", "VITEST SUBTE", "30/8/2026", { usd: 1.17 });
    insertLine("subte_pending_2", "VITEST SUBTE", "31/8/2026", { usd: 1.17 });
    insertLine("subte_settled", "VITEST SUBTE 4042", "30/8/2026", { usd: 1.17 });
    // Same shape, different amount — not the same purchase.
    insertLine("muni_short", "VITEST MUNI", "27/8/2026", { clp: 29990 });
    insertLine("muni_long", "VITEST MUNI 1234", "27/8/2026", { clp: 79 });
  });

  afterAll(() => {
    wipeVitestCcFixtureData();
  });

  it("plans exactly the pending/truncated twins and tags the rule", () => {
    const plan = planTruncatedMerchantDuplicateLines(accountId);
    const byLine = new Map(plan.map((p) => [p.line_id, p]));
    expect([...byLine.keys()].sort((a, b) => a - b)).toEqual(
      [ids.chana_pending, ids.bisonte_pending, ids.farmacity_pending, ids.subte_pending_1].sort(
        (a, b) => a - b
      )
    );
    expect(byLine.get(ids.chana_pending)).toMatchObject({
      keep_line_id: ids.chana_settled,
      rule: "pending_authorization",
      pair: "VITEST CHANA → VITEST CHANA 7142 [pending authorization]",
    });
    expect(byLine.get(ids.bisonte_pending)).toMatchObject({
      keep_line_id: ids.bisonte_settled,
      rule: "pending_authorization",
    });
    expect(byLine.get(ids.farmacity_pending)).toMatchObject({
      keep_line_id: ids.farmacity_settled,
      rule: "truncated",
      pair: "VITEST FARMACIT → VITEST FARMACITY LA PLATA 4584",
    });
    expect(byLine.get(ids.subte_pending_1)).toMatchObject({
      keep_line_id: ids.subte_settled,
      rule: "pending_authorization",
      gap: 0,
    });
    expect(byLine.has(ids.subte_pending_2)).toBe(false);
  });

  it("removes only the shorter rows, reads the evidence date before deleting, and is idempotent", () => {
    const before = db
      .prepare(`SELECT COUNT(*) AS c FROM cc_statement_lines WHERE statement_id = ?`)
      .get(statementId) as { c: number };
    expect(before.c).toBe(14);

    const result = removeTruncatedMerchantDuplicateLines(accountId);
    expect(result.removed_count).toBe(4);
    expect(result.removed_line_ids.sort((a, b) => a - b)).toEqual(
      [ids.chana_pending, ids.bisonte_pending, ids.farmacity_pending, ids.subte_pending_1].sort(
        (a, b) => a - b
      )
    );
    // Earliest removed transaction date (ISO) — the caller's affectedEvidenceFromYmd.
    expect(result.removed_from_date).toBe("2026-08-29");
    expect(result.removed_pairs).toEqual([
      "VITEST BISONTE → VITEST BISONTE HOTEL 4995 [pending authorization]",
      "VITEST CHANA → VITEST CHANA 7142 [pending authorization]",
      "VITEST FARMACIT → VITEST FARMACITY LA PLATA 4584",
      "VITEST SUBTE → VITEST SUBTE 4042 [pending authorization]",
    ]);

    const remaining = (
      db
        .prepare(`SELECT id FROM cc_statement_lines WHERE statement_id = ? ORDER BY id`)
        .all(statementId) as { id: number }[]
    ).map((r) => r.id);
    expect(remaining).toEqual(
      [
        ids.chana_settled,
        ids.bisonte_settled,
        ids.farmacity_settled,
        ids.trgs_pending_alone,
        ids.apple_a,
        ids.apple_b,
        ids.subte_pending_2,
        ids.subte_settled,
        ids.muni_short,
        ids.muni_long,
      ].sort((a, b) => a - b)
    );

    // Second pass finds nothing — settled rows never match each other and the surviving
    // short-name row is on another day, so the hook re-running after every write is safe.
    const again = removeTruncatedMerchantDuplicateLines(accountId);
    expect(again.removed_count).toBe(0);
    expect(again.removed_from_date).toBeNull();
  });
});

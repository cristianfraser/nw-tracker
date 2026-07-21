import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { dayWindowAnchorForAccount, dayWindowAnchorsForToday } from "./dayWindowAnchor.js";
import { db } from "./db.js";

/**
 * Anchor fixture date: Tuesday 2026-06-30. Monday 2026-06-29 is a Chilean holiday (San
 * Pedro y San Pablo) but a regular NYSE session, so all three anchors differ:
 * calendar = 06-29, NYSE = 06-29, Chile business day = Friday 06-26.
 */
const ANCHORS = dayWindowAnchorsForToday("2026-06-30");

let plainAccountId: number | null = null;
let snEquityId: number | null = null;
let usdEquityId: number | null = null;
let cryptoId: number | null = null;

beforeAll(() => {
  const leaf = db
    .prepare(`SELECT id FROM asset_groups WHERE slug LIKE 'brokerage_acciones__%' LIMIT 1`)
    .get() as { id: number } | undefined;
  if (!leaf) return;

  const insAccount = db.prepare(
    `INSERT INTO accounts (asset_group_id, name, notes, import_key, equity_ticker) VALUES (?, ?, ?, ?, ?)`
  );
  const insMov = db.prepare(
    `INSERT INTO movements (account_id, amount_clp, occurred_on, note, flow_kind, units_delta)
     VALUES (?, 1000, '2026-01-15', 'vitest-day-anchor', ?, ?)`
  );

  plainAccountId = Number(
    insAccount.run(leaf.id, "Vitest · anchor plain", "vitest-day-anchor-plain", "vitest-day-anchor-plain", null)
      .lastInsertRowid
  );
  snEquityId = Number(
    insAccount.run(
      leaf.id,
      "Vitest · anchor sn",
      "vitest-day-anchor-sn",
      "vitest-day-anchor-sn",
      "VITESTANCHOR.SN"
    ).lastInsertRowid
  );
  insMov.run(snEquityId, "stock_buy", 10);
  usdEquityId = Number(
    insAccount.run(
      leaf.id,
      "Vitest · anchor usd",
      "vitest-day-anchor-usd",
      "vitest-day-anchor-usd",
      "VITESTANCHOR"
    ).lastInsertRowid
  );
  insMov.run(usdEquityId, "stock_buy", 10);
  cryptoId = Number(
    insAccount.run(
      leaf.id,
      "Vitest · anchor btc",
      "vitest-day-anchor-btc",
      "vitest-day-anchor-btc",
      "BTC-USD"
    ).lastInsertRowid
  );
  insMov.run(cryptoId, null, 0.5);
});

afterAll(() => {
  for (const id of [plainAccountId, snEquityId, usdEquityId, cryptoId]) {
    if (id == null) continue;
    db.prepare(`DELETE FROM movements WHERE account_id = ?`).run(id);
    db.prepare(`DELETE FROM accounts WHERE id = ?`).run(id);
  }
});

describe("dayWindowAnchorsForToday", () => {
  it("resolves three distinct anchors around a Chile-only holiday", () => {
    expect(ANCHORS.calendar).toBe("2026-06-29");
    expect(ANCHORS.nyse).toBe("2026-06-29");
    expect(ANCHORS.chile).toBe("2026-06-26");
  });
});

describe("dayWindowAnchorForAccount", () => {
  it("UF-marked kinds anchor on yesterday regardless of account", () => {
    expect(dayWindowAnchorForAccount(0, "property", ANCHORS)).toBe("2026-06-29");
    expect(dayWindowAnchorForAccount(0, "mortgage", ANCHORS)).toBe("2026-06-29");
  });

  it("crypto anchors on yesterday (trades every day)", () => {
    if (cryptoId == null) return;
    expect(dayWindowAnchorForAccount(cryptoId, "bitcoin", ANCHORS)).toBe("2026-06-29");
  });

  it("USD-quoted stocks anchor on the prior NYSE session", () => {
    if (usdEquityId == null) return;
    expect(dayWindowAnchorForAccount(usdEquityId, "spy", ANCHORS)).toBe("2026-06-29");
  });

  it(".SN stocks anchor on the prior Chilean business day", () => {
    if (snEquityId == null) return;
    expect(dayWindowAnchorForAccount(snEquityId, "ipsa", ANCHORS)).toBe("2026-06-26");
  });

  it("retirement / efectivo / stored-mark accounts anchor on the prior Chilean business day", () => {
    if (plainAccountId == null) return;
    expect(dayWindowAnchorForAccount(plainAccountId, "afp", ANCHORS)).toBe("2026-06-26");
    expect(dayWindowAnchorForAccount(plainAccountId, "cuenta_corriente", ANCHORS)).toBe("2026-06-26");
  });
});

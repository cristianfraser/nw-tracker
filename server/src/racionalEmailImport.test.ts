import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { brokerNotification } from "./test/brokerNotificationFixtures.js";
import { chileCalendarAddDays } from "./chileDate.js";
import { db } from "./db.js";
import { nextChileBusinessDayYmd } from "./marketHolidays.js";
import { planRacionalEmailMovements } from "./racionalEmailImport.js";

/** Real 2026-08-25 template facts (amounts anonymized to synthetic values), as ingest reads them. */
function deposit(at: string, messageId: string) {
  return brokerNotification({
    kind: "deposit",
    subject: "Tu depósito de CLP $1.000.000 está listo para invertir",
    occurred_at: at,
    message_id: messageId,
    amount: 1_000_000,
    currency: "clp",
  });
}

function conversion(at: string, messageId: string, clpAmount: number | null) {
  return brokerNotification({
    kind: "wallet_funded",
    subject: "Agregaste USD $1.086,49 a tu Billetera",
    occurred_at: at,
    message_id: messageId,
    amount: 1086.49,
    currency: "usd",
    clp_amount: clpAmount,
  });
}

/** Find-or-create an account by import_key; cleanup only removes rows this test created. */
function ensureAccount(importKey: string, name: string): { id: number; cleanup: () => void } {
  const existing = db.prepare(`SELECT id FROM accounts WHERE import_key = ?`).get(importKey) as
    | { id: number }
    | undefined;
  if (existing) return { id: existing.id, cleanup: () => {} };
  const group = db.prepare(`SELECT id FROM asset_groups ORDER BY id LIMIT 1`).get() as {
    id: number;
  };
  const id = Number(
    db
      .prepare(`INSERT INTO accounts (asset_group_id, name, notes, import_key) VALUES (?, ?, ?, ?)`)
      .run(group.id, name, importKey, importKey).lastInsertRowid
  );
  return { id, cleanup: () => db.prepare(`DELETE FROM accounts WHERE id = ?`).run(id) };
}

describe("planRacionalEmailMovements", () => {
  let checking: { id: number; cleanup: () => void };
  let racionalClp: { id: number; cleanup: () => void };
  let racionalUsd: { id: number; cleanup: () => void };

  beforeEach(() => {
    checking = ensureAccount("import:excel|key=cuenta_corriente", "vitest checking");
    racionalClp = ensureAccount("import:panel|kind=clp|key=clp", "vitest racional clp");
    racionalUsd = ensureAccount("import:panel|kind=usd|key=usd", "vitest racional usd");
  });

  afterEach(() => {
    db.prepare(`DELETE FROM movements WHERE note LIKE 'Racional e-mail:%(2099-%'`).run();
    db.prepare(`DELETE FROM movements WHERE note = 'vitest-racional-email'`).run();
    racionalUsd.cleanup();
    racionalClp.cleanup();
    checking.cleanup();
  });

  /** A mid-month Chile business day in 2099 whose next business day stays in the month. */
  function safeYmd(): string {
    let d = "2099-03-10";
    for (let i = 0; i < 10; i++) {
      const next = nextChileBusinessDayYmd(d);
      if (next != null && next.slice(0, 7) === d.slice(0, 7)) return d;
      d = chileCalendarAddDays(d, 1);
    }
    throw new Error("no safe mid-month day found");
  }

  function eventsFor(ymd: string) {
    const iso = `${ymd}T16:00:00.000Z`; // 12:00 Chile — same calendar day
    return [
      deposit(iso, "<vitest-dep@test>"),
      conversion(iso, "<vitest-conv@test>", 1_000_000),
      brokerNotification({
        kind: "buy",
        subject: "Invertiste en Vitest Semis ETF (VITSOX)",
        occurred_at: iso,
        message_id: "<vitest-buy@test>",
        ticker: "VITSOX",
        units: "2.11462728",
        price: 513.8,
        amount: 1086.49,
        currency: "usd",
      }),
    ];
  }

  it("plans deposit and conversion transfers with the ledger's leg conventions", () => {
    const ymd = safeYmd();
    const planned = planRacionalEmailMovements(eventsFor(ymd));
    const dep = planned.find((p) => p.kind === "deposit")!;
    expect(dep).toMatchObject({
      occurred_on: ymd,
      amount: 1_000_000,
      currency: "clp",
      from_account_id: checking.id,
      to_account_id: racionalClp.id,
      duplicate_of: null,
      requires_manual: null,
    });
    const conv = planned.find((p) => p.kind === "conversion")!;
    expect(conv).toMatchObject({
      amount: 1_000_000,
      currency: "clp",
      counter_amount: 1086.49,
      counter_currency: "usd",
      from_account_id: racionalClp.id,
      to_account_id: racionalUsd.id,
      flow_kind: "compra_usd_venta_clp",
      requires_manual: null,
    });
    // No VITSOX account and no Racional sibling buys in this DB → refuse to guess a bucket.
    const buy = planned.find((p) => p.kind === "buy")!;
    expect(buy.requires_manual ?? "").toContain("create the position in the panel");
  });

  it("marks same-day ledger twins as duplicates and existing checking debits as manual", () => {
    const ymd = safeYmd();
    db.prepare(
      `INSERT INTO movements (from_account_id, to_account_id, amount, currency, occurred_on, note)
       VALUES (?, ?, 1000000, 'clp', ?, 'vitest-racional-email')`
    ).run(checking.id, racionalClp.id, ymd);
    const dep = planRacionalEmailMovements(eventsFor(ymd)).find((p) => p.kind === "deposit")!;
    expect(dep.duplicate_of).not.toBeNull();

    // A bank-listed single-leg debit (signed negative) blocks synthesis instead of doubling it.
    db.prepare(`DELETE FROM movements WHERE note = 'vitest-racional-email'`).run();
    db.prepare(
      `INSERT INTO movements (account_id, amount, currency, occurred_on, note)
       VALUES (?, -1000000, 'clp', ?, 'vitest-racional-email')`
    ).run(checking.id, ymd);
    const dep2 = planRacionalEmailMovements(eventsFor(ymd)).find((p) => p.kind === "deposit")!;
    expect(dep2.requires_manual ?? "").toContain("convert it to a transfer");
  });

  it("requires manual entry when the conversion preview lacks the CLP leg", () => {
    const ymd = safeYmd();
    // A pre-2026-08 short capture printed no «con tu depósito de $X»: no CLP leg to book.
    const shortPreview = conversion(`${ymd}T16:00:00.000Z`, "<vitest-conv-short@test>", null);
    const conv = planRacionalEmailMovements([shortPreview]).find((p) => p.kind === "conversion")!;
    expect(conv.requires_manual ?? "").toContain("no CLP leg");
  });

  it("never books a dividend from mail — both templates are nudges for the crawl", () => {
    const ymd = safeYmd();
    const iso = `${ymd}T12:00:00.000Z`;
    const group = db.prepare(`SELECT id FROM asset_groups ORDER BY id LIMIT 1`).get() as { id: number };
    const holder = Number(
      db
        .prepare(
          `INSERT INTO accounts (asset_group_id, name, notes, import_key, equity_ticker)
           VALUES (?, 'vitest VTDIV', 'vitest:racional-dividend', 'vitest:racional-dividend|VTDIV', 'VTDIV')`
        )
        .run(group.id).lastInsertRowid
    );
    try {
      // The 2026-09-18 template states the GROSS dividend (Racional credits the net after the
      // 15% US withholding), so even with a held ticker and a subject amount nothing is planned.
      const grossOnly = brokerNotification({
        kind: "dividend",
        subject: "Recibiste USD $2,75 en dividendos de VTDIV",
        occurred_at: iso,
        message_id: "<vitest-div@test>",
        ticker: "VTDIV",
        gross_amount: 2.75,
        currency: "usd",
      });
      expect(planRacionalEmailMovements([grossOnly])).toEqual([]);

      // The old amount-less template is not planned either.
      const nudge = brokerNotification({
        kind: "dividend",
        subject: "Recibiste dividendos de VTDIV 💸",
        occurred_at: iso,
        message_id: "<vitest-div-old@test>",
        ticker: "VTDIV",
        currency: "usd",
      });
      expect(planRacionalEmailMovements([nudge])).toEqual([]);
    } finally {
      db.prepare(`DELETE FROM movements WHERE from_account_id = ? OR to_account_id = ?`).run(holder, holder);
      db.prepare(`DELETE FROM accounts WHERE id = ?`).run(holder);
    }
  });

  it("books a deposit on the month's last business day like any other", () => {
    // Find a month-end whose next business day lands in the following month.
    let d = "2099-01-31";
    for (let i = 0; i < 24; i++) {
      const next = nextChileBusinessDayYmd(d);
      if (next != null && next.slice(0, 7) !== d.slice(0, 7)) break;
      d = chileCalendarAddDays(d, 1);
    }
    const dep = planRacionalEmailMovements([
      deposit(`${d}T16:00:00.000Z`, "<vitest-dep-eom@test>"),
    ]).find((p) => p.kind === "deposit")!;
    expect(dep.requires_manual).toBeNull();
    expect(dep.occurred_on).toBe(d);
  });
});

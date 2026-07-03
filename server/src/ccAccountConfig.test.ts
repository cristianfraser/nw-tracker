import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  applyCreditCardConfigPatch,
  getCreditCardAccountConfig,
  isCreditCardAccountId,
  listOperationalCreditCards,
  parseCreditCardConfigPatch,
} from "./ccAccountConfig.js";
import { db } from "./db.js";
import {
  ensureVitestCreditCardFixtures,
  getVitestSantanderCcMasterAccountId,
  wipeVitestCcFixtureData,
} from "./test/vitestDbSeed.js";

let accountId: number;
let originalConfig: {
  billing_cycle_start_day: number;
  billing_cycle_end_day: number | null;
  cupo_clp: number | null;
  cupo_usd: number | null;
} | null = null;

beforeAll(() => {
  ensureVitestCreditCardFixtures();
  const id = getVitestSantanderCcMasterAccountId();
  if (id == null) throw new Error("vitest CC fixture master missing");
  accountId = id;
  originalConfig = db
    .prepare(
      `SELECT billing_cycle_start_day, billing_cycle_end_day, cupo_clp, cupo_usd
       FROM credit_card_account_config WHERE account_id = ?`
    )
    .get(accountId) as typeof originalConfig;
});

afterAll(() => {
  if (originalConfig) {
    db.prepare(
      `UPDATE credit_card_account_config
       SET billing_cycle_start_day = ?, billing_cycle_end_day = ?, cupo_clp = ?, cupo_usd = ?
       WHERE account_id = ?`
    ).run(
      originalConfig.billing_cycle_start_day,
      originalConfig.billing_cycle_end_day,
      originalConfig.cupo_clp,
      originalConfig.cupo_usd,
      accountId
    );
  }
  wipeVitestCcFixtureData();
});

describe("parseCreditCardConfigPatch (fail-fast validation)", () => {
  it("rejects non-object bodies", () => {
    expect(() => parseCreditCardConfigPatch(null)).toThrow(/JSON object/);
    expect(() => parseCreditCardConfigPatch([1])).toThrow(/JSON object/);
    expect(() => parseCreditCardConfigPatch("x")).toThrow(/JSON object/);
  });

  it("rejects unknown fields", () => {
    expect(() => parseCreditCardConfigPatch({ cupo_clp: 1 })).toThrow(/unknown field: cupo_clp/);
    expect(() => parseCreditCardConfigPatch({ card_last4: "1234" })).toThrow(
      /unknown field: card_last4/
    );
    expect(() => parseCreditCardConfigPatch({ notes: "x" })).toThrow(/unknown field: notes/);
  });

  it("rejects empty patches", () => {
    expect(() => parseCreditCardConfigPatch({})).toThrow(/no editable fields/);
  });

  it("validates billing cycle days", () => {
    expect(() => parseCreditCardConfigPatch({ billing_cycle_start_day: 0 })).toThrow(
      /billing_cycle_start_day/
    );
    expect(() => parseCreditCardConfigPatch({ billing_cycle_start_day: 12.5 })).toThrow(
      /billing_cycle_start_day/
    );
    expect(() => parseCreditCardConfigPatch({ billing_cycle_end_day: 32 })).toThrow(
      /billing_cycle_end_day/
    );
    expect(parseCreditCardConfigPatch({ billing_cycle_end_day: null })).toEqual({
      billing_cycle_end_day: null,
    });
  });

  it("validates cupo entries", () => {
    expect(() => parseCreditCardConfigPatch({ cupo: {} })).toThrow(/cupo must be an array/);
    expect(() => parseCreditCardConfigPatch({ cupo: [] })).toThrow(/at least one entry/);
    expect(() => parseCreditCardConfigPatch({ cupo: [{ currency: "eur", value: 1 }] })).toThrow(
      /'clp' or 'usd'/
    );
    expect(() =>
      parseCreditCardConfigPatch({
        cupo: [
          { currency: "clp", value: 1 },
          { currency: "clp", value: 2 },
        ],
      })
    ).toThrow(/duplicate cupo entry/);
    expect(() =>
      parseCreditCardConfigPatch({ cupo: [{ currency: "clp", value: -5 }] })
    ).toThrow(/finite number >= 0/);
    expect(() =>
      parseCreditCardConfigPatch({ cupo: [{ currency: "clp", value: Number.NaN }] })
    ).toThrow(/finite number >= 0/);
    expect(() =>
      parseCreditCardConfigPatch({ cupo: [{ currency: "clp", value: 1000.5 }] })
    ).toThrow(/integer amount of pesos/);
    expect(() =>
      parseCreditCardConfigPatch({ cupo: [{ currency: "clp", value: 1, extra: 2 }] })
    ).toThrow(/unknown cupo entry field: extra/);
    expect(
      parseCreditCardConfigPatch({
        cupo: [
          { currency: "clp", value: 5_000_000 },
          { currency: "usd", value: 3200.5 },
        ],
      })
    ).toEqual({
      cupo: [
        { currency: "clp", value: 5_000_000 },
        { currency: "usd", value: 3200.5 },
      ],
    });
  });
});

describe("credit-card account config get/patch (synthetic fixture)", () => {
  it("guards non-credit-card accounts", () => {
    expect(isCreditCardAccountId(accountId)).toBe(true);
    expect(isCreditCardAccountId(-1)).toBe(false);
    expect(() => getCreditCardAccountConfig(999_999_999)).toThrow(/not a credit-card account/);
  });

  it("returns config with cupo in value+currency shape", () => {
    const config = getCreditCardAccountConfig(accountId);
    expect(config.account_id).toBe(accountId);
    expect(config.card_last4).toBe("0000");
    expect(config.billing_cycle_start_day).toBe(21);
    expect(config.cupo.map((c) => c.currency)).toEqual(["clp", "usd"]);
  });

  it("updates cupo values and preserves billing cycle", () => {
    const before = getCreditCardAccountConfig(accountId);
    const { config, billingCycleChanged } = applyCreditCardConfigPatch(accountId, {
      cupo: [
        { currency: "clp", value: 7_500_000 },
        { currency: "usd", value: 4100 },
      ],
    });
    expect(billingCycleChanged).toBe(false);
    expect(config.cupo).toEqual([
      { currency: "clp", value: 7_500_000 },
      { currency: "usd", value: 4100 },
    ]);
    expect(config.billing_cycle_start_day).toBe(before.billing_cycle_start_day);
    expect(config.billing_cycle_end_day).toBe(before.billing_cycle_end_day);
    expect(config.card_last4).toBe(before.card_last4);
  });

  it("partial cupo patch keeps the other currency", () => {
    applyCreditCardConfigPatch(accountId, {
      cupo: [
        { currency: "clp", value: 1_000_000 },
        { currency: "usd", value: 2000 },
      ],
    });
    const { config } = applyCreditCardConfigPatch(accountId, {
      cupo: [{ currency: "clp", value: 2_000_000 }],
    });
    expect(config.cupo).toEqual([
      { currency: "clp", value: 2_000_000 },
      { currency: "usd", value: 2000 },
    ]);
  });

  it("clears a cupo with null", () => {
    const { config } = applyCreditCardConfigPatch(accountId, {
      cupo: [{ currency: "usd", value: null }],
    });
    expect(config.cupo.find((c) => c.currency === "usd")?.value).toBeNull();
  });

  it("updates billing cycle days and flags the change", () => {
    const { config, billingCycleChanged } = applyCreditCardConfigPatch(accountId, {
      billing_cycle_start_day: 22,
      billing_cycle_end_day: 21,
    });
    expect(billingCycleChanged).toBe(true);
    expect(config.billing_cycle_start_day).toBe(22);
    expect(config.billing_cycle_end_day).toBe(21);

    const noop = applyCreditCardConfigPatch(accountId, {
      billing_cycle_start_day: 22,
    });
    expect(noop.billingCycleChanged).toBe(false);
  });
});

describe("listOperationalCreditCards", () => {
  it("includes the fixture master with its config", () => {
    const cards = listOperationalCreditCards();
    const fixture = cards.find((c) => c.account_id === accountId);
    expect(fixture).toBeDefined();
    expect(fixture!.name).toContain("Vitest");
    expect(fixture!.card_last4).toBe("0000");
    expect(fixture!.cupo.map((c) => c.currency)).toEqual(["clp", "usd"]);
    expect(typeof fixture!.has_installment_ledger).toBe("boolean");
  });
});

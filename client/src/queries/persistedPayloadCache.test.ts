import { DTO_SCHEMA_VERSIONS } from "nw-tracker-contracts/dto/schemaVersions";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  PERSISTED_PAYLOAD_VERSIONS,
  hasSchemaVersion,
  persistedPayload,
  persistedPayloadKey,
  readPersistedPayload,
  sweepPersistedPayloads,
  writePersistedPayload,
} from "./persistedPayloadCache";
import {
  initialHeldUnitState,
  renderHeldUnit,
  renderStoredFirstPaint,
  resetHeldUnitSession,
  settleHeldUnit,
  type HeldUnitState,
} from "./heldUnitPayload";

let storage = new Map<string, string>();

beforeEach(() => {
  storage = new Map();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => void storage.set(key, value),
    removeItem: (key: string) => void storage.delete(key),
    key: (i: number) => [...storage.keys()][i] ?? null,
    get length() {
      return storage.size;
    },
  });
});

type Payload = { schema_version: number; rows: number[] };

const LATEST = persistedPayload(
  "latest_movements",
  (v): v is Payload => hasSchemaVersion(v, "latest_movements") && Array.isArray((v as Payload).rows)
);
const current = (rows: number[]): Payload => ({ schema_version: DTO_SCHEMA_VERSIONS.latest_movements, rows });

describe("persisted payload cache", () => {
  it("stores and reads a payload under its name, version and scope", () => {
    expect(writePersistedPayload(LATEST, ["clp"], current([1, 2]))).toBe(true);
    expect(storage.has(`nw:cache:latest_movements:v${DTO_SCHEMA_VERSIONS.latest_movements}:clp`)).toBe(true);
    expect(readPersistedPayload(LATEST, ["clp"])).toEqual(current([1, 2]));
    expect(readPersistedPayload(LATEST, ["usd"])).toBeUndefined();
  });

  it("never stores a payload of another schema version (a server lagging a deploy)", () => {
    const old = { schema_version: DTO_SCHEMA_VERSIONS.latest_movements - 1, rows: [] };
    expect(writePersistedPayload(LATEST, [], old as Payload)).toBe(false);
    expect(storage.size).toBe(0);
  });

  it("drops an entry in a shape this client does not read", () => {
    const key = persistedPayloadKey("latest_movements");
    storage.set(key, JSON.stringify({ schema_version: DTO_SCHEMA_VERSIONS.latest_movements }));
    expect(readPersistedPayload(LATEST)).toBeUndefined();
    expect(storage.has(key)).toBe(false);
    storage.set(key, "{not json");
    expect(readPersistedPayload(LATEST)).toBeUndefined();
  });

  it("sweeps older versions, unknown names and the keys of the earlier conventions", () => {
    const keep = persistedPayloadKey("group_shell", ["brokerage", "clp"]);
    const v = PERSISTED_PAYLOAD_VERSIONS.nav_strip;
    for (const k of [
      keep,
      `nw:cache:nav_strip:v${v - 1}:clp`,
      `nw:cache:retired_name:v1`,
      "nw:dashboard-nav-snapshot-v16:clp",
      "nw:sidebar-nav-v6",
      "nw:group-shell-v2:brokerage:usd",
      "nw:panel-cache:upcoming-v4",
      "nw-tracker.timeRange",
      "nw:numberFlowMount:x",
      "nw-tracker.displayUnit",
    ]) {
      storage.set(k, "{}");
    }
    sweepPersistedPayloads();
    expect([...storage.keys()].sort()).toEqual([keep, "nw-tracker.displayUnit"].sort());
  });
});


describe("a home panel's first paint (the session's memory)", () => {
  type Rows = { rows: string[] };
  const ENTITY = "latestMovements|15";

  /**
   * The browser session around one panel («Últimos movimientos»): react-query's cache per unit
   * (data and fetch time, or a failed fetch), the panel's stored copies per unit, and what the panel
   * stored. `mount()` draws the panel the way `useHeldUnitQuery` + `usePersistedPayload` do
   * (`renderHeldUnit`, `renderStoredFirstPaint`); a new mount starts with empty component state.
   */
  function session(storage: Record<string, Rows>) {
    resetHeldUnitSession();
    const cache: Record<string, { data: Rows; updatedAt: number }> = {};
    const failed: Record<string, Error> = {};
    const writes = new Set<string>();
    const mount = () => {
      let local: HeldUnitState<Rows> = initialHeldUnitState();
      const show = (unit: string) => {
        const step = renderHeldUnit(local, {
          candidate: cache[unit],
          pending: cache[unit] == null && failed[unit] == null,
          error: failed[unit] ?? null,
          unit,
          entity: ENTITY,
          key: `${ENTITY}|${unit}`,
          enabled: true,
          canRefetch: true,
        });
        local = step.local;
        const view = step.view;
        // Only the requested key's own fetched payload is stored.
        if (view.live) writes.add(`${unit}:${view.live.rows.join("")}`);
        const stored = renderStoredFirstPaint<Rows>(`latest_movements|${ENTITY}`, {
          shown: view.data !== undefined,
          failed: view.error != null,
          unit,
          read: () => storage[unit],
        });
        const storedUnit = view.data !== undefined ? undefined : stored.unit;
        return {
          rows: (view.data ?? stored.value)?.rows.join("") ?? null,
          unit: storedUnit ?? view.unit ?? null,
          loading: storedUnit != null ? storedUnit !== unit : view.loading,
          error: view.error,
          refetchAgainst: step.refetchAgainst,
        };
      };
      const settle = (unit: string, against: number) => {
        local = settleHeldUnit(local, `${ENTITY}|${unit}`, against);
      };
      return { show, settle };
    };
    const fetched = (unit: string, rows: string[], at: number) => {
      cache[unit] = { data: { rows }, updatedAt: at };
      delete failed[unit];
    };
    const fail = (unit: string) => {
      failed[unit] = new Error("down");
    };
    return { mount, fetched, fail, writes, cache };
  }

  it("a remount holds what the panel drew last, and refetches an older copy of the unit", () => {
    const s = session({ usd: { rows: ["o"] } });
    const home = s.mount();
    s.fetched("usd", ["a", "b", "c"], 10);
    expect(home.show("usd")).toMatchObject({ rows: "abc", unit: "usd", loading: false });
    // clp on the home page: usd's rows stay, dimmed, until clp's arrive.
    expect(home.show("clp")).toMatchObject({ rows: "abc", unit: "usd", loading: true });
    s.fetched("clp", ["d", "a", "b", "c"], 20);
    expect(home.show("clp")).toMatchObject({ rows: "dabc", unit: "clp", loading: false });
    // Another page switches to usd; back home, the panel mounts afresh with usd's older copy cached.
    const back = s.mount();
    expect(back.show("usd")).toMatchObject({ rows: "dabc", unit: "clp", loading: true, refetchAgainst: 20 });
    s.fetched("usd", ["d", "a", "b", "c"], 30);
    back.settle("usd", 20);
    expect(back.show("usd")).toMatchObject({ rows: "dabc", unit: "usd", loading: false });
    // And with the cached copy collected, a remount holds too: the stored copy never stands in.
    delete s.cache.usd;
    expect(s.mount().show("usd")).toMatchObject({ rows: "dabc", unit: "usd", loading: true });
  });

  it("a stored copy painted after a reload is held across a quick switch, never swapped for another", () => {
    const s = session({ clp: { rows: ["d", "a", "b", "c"] }, usd: { rows: ["a", "b", "c"] }, eur: { rows: ["x"] } });
    const p = s.mount();
    // Reload in clp: the stored clp copy paints, undimmed.
    expect(p.show("clp")).toMatchObject({ rows: "dabc", unit: "clp", loading: false });
    // usd before clp's fetch lands: the clp copy stays, dimmed; usd's older stored copy is not read.
    expect(p.show("usd")).toMatchObject({ rows: "dabc", unit: "clp", loading: true });
    // eur, then a remount: still the copy on screen, in its own unit.
    expect(p.show("eur")).toMatchObject({ rows: "dabc", unit: "clp", loading: true });
    expect(s.mount().show("eur")).toMatchObject({ rows: "dabc", unit: "clp", loading: true });
    // A fetched payload replaces it, whatever its unit.
    s.fetched("eur", ["e", "d", "a", "b", "c"], 5);
    expect(p.show("eur")).toMatchObject({ rows: "edabc", unit: "eur", loading: false });
  });

  it("a failed request reports its error, never a stored copy in its place", () => {
    const s = session({ usd: { rows: ["o"] } });
    s.fail("usd");
    expect(s.mount().show("usd")).toMatchObject({ rows: null, loading: false, error: expect.any(Error) });
    // After the panel drew a payload: a failed unit ends the hold with its error, then a remount
    // still reads no stored copy.
    const t = session({ usd: { rows: ["o"] }, clp: { rows: ["p"] } });
    const p = t.mount();
    t.fetched("usd", ["a"], 10);
    p.show("usd");
    t.fail("clp");
    expect(p.show("clp")).toMatchObject({ rows: null, error: expect.any(Error) });
    t.fetched("clp", ["b"], 20);
    expect(p.show("clp")).toMatchObject({ rows: "b", unit: "clp", error: null });
  });

  it("holds the payload on screen in its unit through three units; only live data is stored", () => {
    const s = session({});
    const p = s.mount();
    s.fetched("clp", ["a"], 10);
    expect(p.show("clp")).toMatchObject({ rows: "a", unit: "clp" });
    expect(p.show("usd")).toMatchObject({ rows: "a", unit: "clp", loading: true });
    // usd still pending, eur asked: still the clp rows (the payload on screen, not the previous unit).
    expect(p.show("eur")).toMatchObject({ rows: "a", unit: "clp", loading: true });
    s.fetched("eur", ["b", "a"], 20);
    expect(p.show("eur")).toMatchObject({ rows: "ba", unit: "eur", loading: false });
    expect(s.writes).toEqual(new Set(["clp:a", "eur:ba"]));
  });
});

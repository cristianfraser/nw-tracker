import { DTO_SCHEMA_VERSIONS } from "nw-tracker-contracts/dto/schemaVersions";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  PERSISTED_PAYLOAD_VERSIONS,
  firstPaint,
  hasSchemaVersion,
  persistedPayload,
  persistedPayloadKey,
  readPersistedPayload,
  sweepPersistedPayloads,
  writePersistedPayload,
} from "./persistedPayloadCache";
import { initialHeldUnitState, settleHeldUnit, stepHeldUnit, type HeldUnitState } from "./heldUnitPayload";

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

describe("a home panel's first paint", () => {
  type Rows = { rows: string[] };
  /**
   * One panel («Últimos movimientos»): its held query (`stepHeldUnit`, as `useHeldUnitQuery` drives
   * it) and its stored copies per unit (`firstPaint`, as `usePersistedPayload` picks).
   */
  function panel(stored: Record<string, Rows>) {
    let state: HeldUnitState<Rows> = initialHeldUnitState();
    const cache: Record<string, { data: Rows; updatedAt: number }> = {};
    const writes: [string, Rows][] = [];
    const show = (unit: string) => {
      const step = stepHeldUnit(state, {
        candidate: cache[unit],
        pending: cache[unit] == null,
        error: null,
        unit,
        entity: "latestMovements|15",
        key: `latestMovements|15|${unit}`,
        enabled: true,
        canRefetch: true,
      });
      state = step.state;
      // The panel stores only the requested key's own fetched payload.
      if (step.view.live) writes.push([unit, step.view.live]);
      return { ...firstPaint(step.view.data, stored[unit]), loading: step.view.loading, refetchAgainst: step.refetchAgainst };
    };
    const fetched = (unit: string, rows: string[], at: number) => {
      cache[unit] = { data: { rows }, updatedAt: at };
    };
    const settle = (unit: string, against: number) => {
      state = settleHeldUnit(state, `latestMovements|15|${unit}`, against);
    };
    return { show, fetched, settle, writes };
  }

  it("paints the stored copy only before anything is shown, and never steps back to an older copy", () => {
    const p = panel({ usd: { rows: ["old"] }, clp: { rows: ["old clp"] } });
    // Reload in usd: the stored copy paints, undimmed, until the server answers.
    expect(p.show("usd")).toMatchObject({ value: { rows: ["old"] }, stored: true });
    p.fetched("usd", ["a", "b", "c"], 10);
    expect(p.show("usd")).toMatchObject({ value: { rows: ["a", "b", "c"] }, stored: false });
    // Switch to clp: usd's rows stay, dimmed; clp's stored copy never replaces them.
    expect(p.show("clp")).toMatchObject({ value: { rows: ["a", "b", "c"] }, stored: false, loading: true });
    p.fetched("clp", ["d", "a", "b", "c"], 20);
    expect(p.show("clp")).toMatchObject({ value: { rows: ["d", "a", "b", "c"] }, loading: false });
    // Back to usd: the cached [a b c] predates what is on screen: clp's rows stay, usd refetches.
    const back = p.show("usd");
    expect(back).toMatchObject({ value: { rows: ["d", "a", "b", "c"] }, stored: false, loading: true });
    expect(back.refetchAgainst).toBe(20);
    p.fetched("usd", ["d", "a", "b", "c"], 30);
    p.settle("usd", 20);
    expect(p.show("usd")).toMatchObject({ value: { rows: ["d", "a", "b", "c"] }, loading: false });
    // Only live payloads of the requested unit were stored, never a held one under another unit.
    expect(new Set(p.writes.map(([unit, v]) => `${unit}:${v.rows.join("")}`))).toEqual(
      new Set(["usd:abc", "clp:dabc", "usd:dabc"])
    );
  });

  it("shows nothing stored when nothing was stored", () => {
    expect(firstPaint(undefined, undefined)).toEqual({ value: null, stored: false });
    expect(firstPaint({ rows: [] }, { rows: ["s"] })).toEqual({ value: { rows: [] }, stored: false });
  });
});

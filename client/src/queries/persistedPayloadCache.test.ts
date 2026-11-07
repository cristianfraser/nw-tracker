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
  "latest_expenses",
  (v): v is Payload => hasSchemaVersion(v, "latest_expenses") && Array.isArray((v as Payload).rows)
);
const current = (rows: number[]): Payload => ({ schema_version: DTO_SCHEMA_VERSIONS.latest_expenses, rows });

describe("persisted payload cache", () => {
  it("stores and reads a payload under its name, version and scope", () => {
    expect(writePersistedPayload(LATEST, ["clp"], current([1, 2]))).toBe(true);
    expect(storage.has(`nw:cache:latest_expenses:v${DTO_SCHEMA_VERSIONS.latest_expenses}:clp`)).toBe(true);
    expect(readPersistedPayload(LATEST, ["clp"])).toEqual(current([1, 2]));
    expect(readPersistedPayload(LATEST, ["usd"])).toBeUndefined();
  });

  it("never stores a payload of another schema version (a server lagging a deploy)", () => {
    const old = { schema_version: DTO_SCHEMA_VERSIONS.latest_expenses - 1, rows: [] };
    expect(writePersistedPayload(LATEST, [], old as Payload)).toBe(false);
    expect(storage.size).toBe(0);
  });

  it("drops an entry in a shape this client does not read", () => {
    const key = persistedPayloadKey("latest_expenses");
    storage.set(key, JSON.stringify({ schema_version: DTO_SCHEMA_VERSIONS.latest_expenses }));
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

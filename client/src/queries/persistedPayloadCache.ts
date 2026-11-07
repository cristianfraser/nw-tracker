/**
 * The browser's last copy of a payload, so a reload paints the last figures it saw instead of an
 * empty or zero view until the server answers (docs/untangle-plan.md F8): the card strip, the
 * sidebar tree, a group page's shell and the home panels. One key scheme for all of them,
 * `nw:cache:<name>:v<version>[:<scope>…]`, where the version is the payload's `schema_version`
 * (`DTO_SCHEMA_VERSIONS` in contracts) or, for a shape the client builds itself, the client's own.
 *
 * A per-browser convenience: an unreadable entry, or one whose shape this client does not read
 * (`isValid`), is dropped, never an error; a value in another shape is never written (a server
 * still on the previous payload, during a deploy). Older versions and the keys of the conventions
 * before this helper are swept once at boot (`sweepPersistedPayloads`).
 */
import { useEffect } from "react";
import { DTO_SCHEMA_VERSIONS, type DtoSchemaVersionName } from "nw-tracker-contracts/dto/schemaVersions";

const PREFIX = "nw:cache:";

/** Shapes the client builds itself from server payloads. v2: the group shell's `first_month`. */
const CLIENT_SCHEMA_VERSIONS = { group_shell: 2 } as const;

export const PERSISTED_PAYLOAD_VERSIONS = { ...DTO_SCHEMA_VERSIONS, ...CLIENT_SCHEMA_VERSIONS };

export type PersistedPayloadName = keyof typeof PERSISTED_PAYLOAD_VERSIONS;

/** One stored payload: its name (and so its version) and the shape this client reads. */
export interface PersistedPayload<T> {
  name: PersistedPayloadName;
  isValid: (value: unknown) => value is T;
}

export function persistedPayload<T>(
  name: PersistedPayloadName,
  isValid: (value: unknown) => value is T
): PersistedPayload<T> {
  return { name, isValid };
}

/** True when `value` carries the `schema_version` this client reads for `name`. */
export function hasSchemaVersion(value: unknown, name: DtoSchemaVersionName): boolean {
  return (
    value != null &&
    typeof value === "object" &&
    (value as { schema_version?: unknown }).schema_version === DTO_SCHEMA_VERSIONS[name]
  );
}

export function persistedPayloadKey(name: PersistedPayloadName, scope: readonly string[] = []): string {
  return `${PREFIX}${name}:v${PERSISTED_PAYLOAD_VERSIONS[name]}${scope.map((s) => `:${s}`).join("")}`;
}

export function readPersistedPayload<T>(def: PersistedPayload<T>, scope: readonly string[] = []): T | undefined {
  const key = persistedPayloadKey(def.name, scope);
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return undefined;
    const parsed: unknown = JSON.parse(raw);
    if (def.isValid(parsed)) return parsed;
    localStorage.removeItem(key);
    return undefined;
  } catch {
    return undefined;
  }
}

/** Stores `value` when it has the shape this client reads; answers whether it did. */
export function writePersistedPayload<T>(def: PersistedPayload<T>, scope: readonly string[], value: T): boolean {
  if (!def.isValid(value)) return false;
  try {
    localStorage.setItem(persistedPayloadKey(def.name, scope), JSON.stringify(value));
    return true;
  } catch {
    // Storage full or blocked: the view loads from the server next time.
    return false;
  }
}

export function removePersistedPayload(def: PersistedPayload<unknown>, scope: readonly string[] = []): void {
  try {
    localStorage.removeItem(persistedPayloadKey(def.name, scope));
  } catch {
    /* ignore */
  }
}

/**
 * What a view shows: the live payload once it is here (and stored for the next visit), the stored
 * one until then. `cached` tells the view it is showing the stored one. `liveSchemaVersion` is the
 * live payload's own `schema_version` when the stored value is a part of it: a part from a payload
 * in another version is shown but not stored.
 */
export function usePersistedPayload<T>(
  def: PersistedPayload<T>,
  scope: readonly string[],
  live: T | null | undefined,
  liveSchemaVersion?: number
): { value: T | null; cached: boolean } {
  const key = persistedPayloadKey(def.name, scope);
  const versionOk = liveSchemaVersion === undefined || liveSchemaVersion === PERSISTED_PAYLOAD_VERSIONS[def.name];
  useEffect(() => {
    if (live != null && versionOk) writePersistedPayload(def, scope, live);
    // `key` stands for `def` + `scope`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, live, versionOk]);
  if (live != null) return { value: live, cached: false };
  return { value: readPersistedPayload(def, scope) ?? null, cached: true };
}

/** Exact keys no longer read: global prefs that went per-surface, the old fx cache. */
const RETIRED_KEYS = [
  "nw-tracker.metricsPeriod",
  "nw-tracker.timeRange",
  "nw-tracker.chartGranularity",
  "nw:fx-latest-v1",
];

/**
 * Key prefixes no longer read: the payload caches before this helper (each with its own versioned
 * prefix), the credit card's per-purchase schedule offsets, and the number-flow mount seeds.
 */
const RETIRED_PREFIXES = [
  "nw:dashboard-nav-snapshot-v",
  "nw:sidebar-nav-v",
  "nw:group-shell-v",
  "nw:panel-cache:",
  "nw-credit-card-extra-offsets:",
  "nw:numberFlowMount:",
];

function isCurrentPersistedKey(key: string): boolean {
  const m = /^nw:cache:([a-z_]+):v(\d+)(?::|$)/.exec(key);
  if (!m) return false;
  const name = m[1] as PersistedPayloadName;
  return Object.hasOwn(PERSISTED_PAYLOAD_VERSIONS, name) && PERSISTED_PAYLOAD_VERSIONS[name] === Number(m[2]);
}

/** Removes retired keys and every stored payload of a version (or name) this client does not read. */
export function sweepPersistedPayloads(): void {
  try {
    for (const k of RETIRED_KEYS) localStorage.removeItem(k);
    for (let i = localStorage.length - 1; i >= 0; i--) {
      const k = localStorage.key(i);
      if (k == null) continue;
      const retired = RETIRED_PREFIXES.some((p) => k.startsWith(p));
      const staleCache = k.startsWith(PREFIX) && !isCurrentPersistedKey(k);
      if (retired || staleCache) localStorage.removeItem(k);
    }
  } catch {
    /* ignore */
  }
}

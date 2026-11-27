/**
 * The browser's last copy of a payload, so a session's first paint shows the last figures it saw
 * instead of an empty or zero view (docs/untangle-plan.md F8; once anything is drawn, a stored copy
 * is never read again for that surface: `storedFirstPaint`, `heldUnitPayload.ts`): the card strip, the
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
import { storedFirstPaint } from "./heldUnitPayload";
import { useStructuralValue } from "../useStructuralValue";
import { DTO_SCHEMA_VERSIONS, type DtoSchemaVersionName } from "nw-tracker-contracts/dto/schemaVersions";

const PREFIX = "nw:cache:";

/**
 * Shapes the client builds itself from server payloads. v2: the group shell's `first_month`; v3: its
 * rows carry one value per field in the shell's unit (no `_clp` / `_usd` pairs). `cc_glance_shape`:
 * which rows a card's «at a glance» block has (CreditCardGlance.tsx), no amounts.
 * `position_glance_shape`: which optional rows a position page's glance has (PositionGlance.tsx),
 * no amounts; v2 adds whether it has price blocks. A change to one of these types
 * fails `scripts/check-persisted-payloads.mjs` until its version is bumped, like the DTO ones.
 */
const CLIENT_SCHEMA_VERSIONS = { group_shell: 3, cc_glance_shape: 1, position_glance_shape: 2 } as const;

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
 * A home panel over its stored copy: draws `shown` (its request's held view data, or a part of it:
 * live, or held across a switch or a remount, `heldUnitPayload.ts`) and, only before anything was
 * drawn for the panel in this session, the copy stored under `scope` for the requested `unit`
 * (`storedFirstPaint`: once painted it is held, in its own unit, until a payload is drawn; a
 * failed request paints none). Stores `live` (the requested key's own fetched payload, never a held
 * one) under `scope` for the next visit. `storedUnit` is set while the stored copy is drawn: its
 * unit (the scope's: the stored rows may carry none). `liveSchemaVersion` is the live payload's own
 * `schema_version` when the stored value is a part of it: a part from a payload in another version
 * is shown but not stored.
 */
export function usePersistedPayload<T>(
  def: PersistedPayload<T>,
  where: { surface: string; unit: string; scope: readonly string[] },
  view: { shown: T | null | undefined; live: T | null | undefined; failed: boolean },
  liveSchemaVersion?: number
): { value: T | null; storedUnit: string | undefined } {
  const { shown, live, failed } = view;
  const { scope } = where;
  const key = persistedPayloadKey(def.name, scope);
  const versionOk = liveSchemaVersion === undefined || liveSchemaVersion === PERSISTED_PAYLOAD_VERSIONS[def.name];
  useEffect(() => {
    if (live != null && versionOk) writePersistedPayload(def, scope, live);
    // `key` stands for `def` + `scope`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, live, versionOk]);
  const stored = storedFirstPaint<T>(`${def.name}|${where.surface}`, {
    shown: shown != null,
    failed,
    unit: where.unit,
    read: () => readPersistedPayload(def, scope),
  });
  // Shared across the stored → live switch, so equal parts keep their objects.
  const value = useStructuralValue(shown ?? stored.value ?? null);
  return { value, storedUnit: shown != null ? undefined : stored.unit };
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

import { hashKey, useQuery, type UseQueryOptions } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { entityKeyLength, type DisplayUnit } from "./keys";

/**
 * What a surface keeps on screen across a display-unit switch (the two rules of the switch).
 *
 * 1. **Hold.** While the requested unit's payload is pending, the surface keeps showing what it
 *    last showed — the same entity's payload, in ITS unit (every display-unit DTO carries `unit`),
 *    dimmed. Nothing is converted; a different entity (group A → group B) holds nothing; a surface
 *    that is not drawn (its request disabled) keeps nothing to hold later.
 * 2. **Freshness.** A cached copy of the requested unit is shown at once unless it may be missing
 *    a change the payload on screen already shows. Two clocks:
 *    - the target copy's `updatedAt`: when it was last fetched (react-query `dataUpdatedAt`);
 *    - the shown content's `changedAt`: when the payload on screen first arrived with its current
 *      content ({@link contentChangedAt}). Structural sharing keeps a payload's reference while a
 *      refetch returns equal content (`shareKeepingLiveInputs` re-attaches the live inputs to the
 *      kept object), so an equal refetch does not move it and any real change does.
 *    The copy is **older** when `target.updatedAt < shown.changedAt`: the shown content appeared
 *    after the target was fetched, so the target may not have it. Then the surface holds, dimmed,
 *    and the target is refetched once; it is shown when that refetch settles (the new data, or —
 *    on failure — the older copy, which is still that unit's real data). A target fetched at or
 *    after the shown content appeared is shown at once, so toggling back and forth between two
 *    unchanged payloads is instant after the first round trip each way.
 *    Only across units: a period, range or page change of the same unit shows its cached copy as
 *    it is, and a background refetch of the shown key is never «older». A request that cannot be
 *    refetched cannot be held for freshness: its copy is shown.
 * 3. **Errors.** Once the request is no longer pending and has no data of its own, the hold ends:
 *    the surface shows the request's `error` (never held data). A failed background refetch keeps
 *    the data and reports no error (repo rule `queryLoadError`).
 *
 * A copy updated at 0 is a stored first-paint copy (localStorage): it paints a surface that shows
 * nothing yet, is always «older» than anything fetched, and is never `live`.
 */

/** A payload the surface could show: the requested key's own data and when it was fetched. */
export type UnitCandidate<T> = { data: T; updatedAt: number };

/** What a surface shows. */
export type HeldUnitView<T> = {
  /** The payload to draw (format it with its own `unit`): the requested one, or the one held. */
  data: T | undefined;
  /** `data` is not the requested key's own payload (held from before). */
  held: boolean;
  /** Dim the surface: pending with nothing of its own, or a held payload shown. */
  loading: boolean;
  /** The requested key's fetched payload when it is the one shown (never held, never a stored
   * copy). Side effects (stored snapshots, `setQueryData` under a unit key) read this. */
  live: T | undefined;
  /** The request's load error, set only when it has no data to show: show it in place of the
   * surface. Error gates read this, never `queryLoadError` over `data`. */
  error: unknown;
};

/** What a surface showed last. */
type ShownRecord<T> = { data: T; changedAt: number; unit: DisplayUnit; entity: string };

/** A surface's memory: what it shows, and the forced refetches that settled (key → against). */
export type HeldUnitState<T> = {
  shown: ShownRecord<T> | null;
  settled: ReadonlyMap<string, number>;
};

export function initialHeldUnitState<T>(): HeldUnitState<T> {
  return { shown: null, settled: new Map() };
}

export type HeldUnitInput<T> = {
  candidate: UnitCandidate<T> | undefined;
  /** No data of its own yet and the fetch has not failed (`isPending` of an enabled request). */
  pending: boolean;
  error: unknown;
  unit: DisplayUnit;
  /** The entity the payload belongs to: nothing is held across entities. */
  entity: string;
  /** The request (its query key hash). */
  key: string;
  /** The request is active (the surface is drawn). */
  enabled: boolean;
  /** An older copy can be refetched (else it is shown). */
  canRefetch: boolean;
};

const firstSeenAt = new WeakMap<object, number>();

/**
 * When `data`'s content first arrived: the fetch time of the first sighting of this object
 * (structural sharing keeps it across equal refetches). A stored copy (updated at 0) is dated by
 * the first fetch that confirms it. Non-object payloads date by their fetch time.
 */
export function contentChangedAt(data: unknown, updatedAt: number): number {
  if (data === null || typeof data !== "object") return updatedAt;
  const seen = firstSeenAt.get(data);
  if (seen === undefined || (seen === 0 && updatedAt > 0)) {
    firstSeenAt.set(data, updatedAt);
    return updatedAt;
  }
  return seen;
}

/** One render's decision and the surface's next memory (the same object when nothing changed). */
export function stepHeldUnit<T>(
  state: HeldUnitState<T>,
  input: HeldUnitInput<T>
): { view: HeldUnitView<T>; state: HeldUnitState<T>; refetchAgainst: number | null } {
  const { candidate, unit, entity } = input;
  const own = (c: UnitCandidate<T>): HeldUnitView<T> => ({
    data: c.data,
    held: false,
    loading: false,
    live: c.updatedAt > 0 ? c.data : undefined,
    error: null,
  });
  const withShown = (shown: ShownRecord<T> | null): HeldUnitState<T> =>
    shown === state.shown ? state : { ...state, shown };

  if (!input.enabled) {
    // Not drawn: nothing to remember for a later hold.
    const view = candidate
      ? own(candidate)
      : { data: undefined, held: false, loading: input.pending, live: undefined, error: null };
    return { view, state: withShown(null), refetchAgainst: null };
  }
  const prev = state.shown && state.shown.entity === entity ? state.shown : null;
  if (candidate) {
    const older =
      input.canRefetch &&
      prev != null &&
      prev.unit !== unit &&
      candidate.updatedAt < prev.changedAt &&
      state.settled.get(input.key) !== prev.changedAt;
    if (older) {
      return {
        view: { data: prev.data, held: true, loading: true, live: undefined, error: null },
        state,
        refetchAgainst: prev.changedAt,
      };
    }
    const changedAt = contentChangedAt(candidate.data, candidate.updatedAt);
    const same =
      prev != null && prev.data === candidate.data && prev.unit === unit && prev.changedAt === changedAt;
    return {
      view: own(candidate),
      state: same ? state : withShown({ data: candidate.data, changedAt, unit, entity }),
      refetchAgainst: null,
    };
  }
  if (input.pending) {
    const data = prev?.data;
    return {
      view: { data, held: data !== undefined, loading: true, live: undefined, error: null },
      state,
      refetchAgainst: null,
    };
  }
  // Settled with nothing of its own (a failed first fetch): the hold ends, the error shows.
  return {
    view: { data: undefined, held: false, loading: false, live: undefined, error: input.error ?? null },
    state: withShown(null),
    refetchAgainst: null,
  };
}

/** Records that the forced refetch of `key` run against `against` has settled (either way). */
export function settleHeldUnit<T>(state: HeldUnitState<T>, key: string, against: number): HeldUnitState<T> {
  if (state.settled.get(key) === against) return state;
  const settled = new Map(state.settled);
  settled.set(key, against);
  return { ...state, settled };
}

/**
 * {@link stepHeldUnit} as a hook, for a surface whose candidate the page builds (a strip picked
 * from a live payload or a stored snapshot). Keep `candidate.data` referentially stable while its
 * content is (memoize it on the payloads, not on their fetch times): its identity dates the
 * content. `refetch` is run, once per (key, held timestamp), when the requested copy is older;
 * without one an older copy is shown.
 */
export function useHeldUnitValue<T>(opts: {
  candidate: UnitCandidate<T> | undefined;
  pending: boolean;
  error?: unknown;
  unit: DisplayUnit;
  entity: string;
  key: string;
  enabled?: boolean;
  refetch?: () => Promise<unknown>;
}): HeldUnitView<T> {
  const { key, refetch } = opts;
  const [state, setState] = useState<HeldUnitState<T>>(initialHeldUnitState);
  const step = stepHeldUnit(state, {
    candidate: opts.candidate,
    pending: opts.pending,
    error: opts.error ?? null,
    unit: opts.unit,
    entity: opts.entity,
    key,
    enabled: opts.enabled ?? true,
    canRefetch: refetch != null,
  });
  // Derived during render (React re-runs this render before committing it): the first frame of
  // a switch already compares against what was on screen, so a stale copy never flashes.
  if (step.state !== state) setState(step.state);

  const against = step.refetchAgainst;
  useEffect(() => {
    if (against == null || !refetch) return;
    // Settled per key: a late settle of an earlier key never overwrites a later key's.
    void refetch().finally(() => setState((s) => settleHeldUnit(s, key, against)));
    // Once per (request, held timestamp): a re-render while it runs must not refetch again.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, against]);

  return step.view;
}

/** A display-unit query's options (`useQuery` options, with a declared-entity key from `keys.ts`). */
export type UnitQueryOptions<T> = Omit<
  UseQueryOptions<T, Error, T, readonly unknown[]>,
  "enabled" | "placeholderData" | "select" | "queryKey"
> & { queryKey: readonly unknown[]; enabled?: boolean };

/** A held query: the view, plus its live payload's fetch time (0 without one) and a refetch that
 * joins a fetch in flight. */
export type HeldUnitQuery<T> = HeldUnitView<T> & { updatedAt: number; refetch: () => Promise<unknown> };

/**
 * A display-unit query as a surface shows it: runs the query from `options` (one place for key,
 * fetcher and `enabled`, so they cannot drift) and holds per {@link stepHeldUnit}; the entity is
 * the key's declared entity part. React-query's own placeholder is not used: the surface holds
 * only what it drew.
 */
export function useHeldUnitQuery<T>(options: UnitQueryOptions<T>, unit: DisplayUnit): HeldUnitQuery<T> {
  const { queryKey } = options;
  const query = useQuery<T, Error, T, readonly unknown[]>({ ...options, placeholderData: undefined });
  const own = query.data !== undefined && !query.isPlaceholderData ? query.data : undefined;
  // Joins a fetch already in flight (its data is newer than what is shown) instead of restarting it.
  const refetch = () => query.refetch({ cancelRefetch: false });
  const view = useHeldUnitValue<T>({
    candidate: own !== undefined ? { data: own, updatedAt: query.dataUpdatedAt } : undefined,
    pending: query.isPending,
    error: query.error,
    unit,
    entity: hashKey(queryKey.slice(0, entityKeyLength(queryKey))),
    key: hashKey(queryKey),
    enabled: options.enabled !== false,
    refetch,
  });
  return { ...view, updatedAt: view.live !== undefined ? query.dataUpdatedAt : 0, refetch };
}

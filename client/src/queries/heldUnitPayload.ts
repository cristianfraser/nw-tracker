import { hashKey, type UseQueryResult } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { entityKeyLength, type DisplayUnit } from "./keys";

/**
 * What a surface keeps on screen across a display-unit switch (the two rules of the switch):
 *
 * 1. **Hold.** Until the requested unit's payload is on hand, the surface keeps showing what it
 *    showed — the same entity's payload, in ITS unit (every display-unit DTO carries `unit`),
 *    dimmed. Nothing is converted; a different entity (group A → group B) holds nothing.
 * 2. **Freshness.** A cached copy of the requested unit is shown only when it is at least as new
 *    (`dataUpdatedAt`) as the payload on screen. An older copy (react-query may still call it
 *    fresh) stays hidden: the surface keeps holding, dimmed, and the copy is refetched once; it is
 *    shown when that refetch settles (the new data, or the old copy when the refetch failed). A
 *    copy at least as new switches at once. A copy read from storage counts as updated at 0, so it
 *    paints only a surface that shows nothing yet.
 *
 * The comparison applies across units only: a period, range or page change of the same unit shows
 * its cached copy as before, and a background refetch of the shown key is never «older».
 */

/** A payload the surface could show: the requested key's own data and when it was fetched. */
export type UnitCandidate<T> = { data: T; updatedAt: number };

/** What a surface shows: the payload, whether it is held, whether to dim, and the live payload. */
export type HeldUnitPayload<T> = {
  /** The payload to draw (format it with its own `unit`): the requested one, or the one held. */
  data: T | undefined;
  /** `data` is not the requested key's live payload (held from before the switch). */
  held: boolean;
  /** Dim the surface: nothing of the request's own yet (pending, or a held payload shown). */
  loading: boolean;
  /** The requested key's payload when it is the one shown; undefined while held. Side effects
   * (stored snapshots, `setQueryData` under a unit key) read this, never `data`. */
  live: T | undefined;
};

/** What a surface showed last: its payload, fetch time, the unit it was requested in, its entity. */
export type ShownUnitPayload<T> = { data: T; updatedAt: number; unit: DisplayUnit; entity: string };

export type HeldUnitStep<T> = HeldUnitPayload<T> & {
  /** What to remember as shown after this render (null: keep the previous record). */
  record: ShownUnitPayload<T> | null;
  /** The requested copy is older than the one shown: refetch it, once per this timestamp. */
  refetchAgainst: number | null;
};

/** One render's decision (pure; {@link useHeldUnitValue} keeps the record and runs the refetch). */
export function resolveHeldUnitPayload<T>(input: {
  candidate: UnitCandidate<T> | undefined;
  /** What react-query offers while the request has nothing (its same-entity placeholder). */
  fallback: T | undefined;
  /** The request has no data of its own yet (`isPending`). */
  pending: boolean;
  unit: DisplayUnit;
  entity: string;
  /** A disabled request never holds over its copy (nothing would refetch it). */
  enabled: boolean;
  shown: ShownUnitPayload<T> | null;
  /** The timestamp a settled forced refetch of this request was run against, if any. */
  refetchSettledAgainst: number | null;
}): HeldUnitStep<T> {
  const { candidate, unit, entity } = input;
  const prev = input.shown && input.shown.entity === entity ? input.shown : null;
  if (candidate) {
    const older = input.enabled && prev != null && prev.unit !== unit && candidate.updatedAt < prev.updatedAt;
    if (older && input.refetchSettledAgainst !== prev.updatedAt) {
      return { data: prev.data, held: true, loading: true, live: undefined, record: null, refetchAgainst: prev.updatedAt };
    }
    return {
      data: candidate.data,
      held: false,
      loading: false,
      live: candidate.data,
      record: { data: candidate.data, updatedAt: candidate.updatedAt, unit, entity },
      refetchAgainst: null,
    };
  }
  const data = prev ? prev.data : input.fallback;
  return {
    data,
    held: data !== undefined,
    loading: input.pending || data !== undefined,
    live: undefined,
    record: null,
    refetchAgainst: null,
  };
}

function sameRecord<T>(a: ShownUnitPayload<T> | null, b: ShownUnitPayload<T>): boolean {
  return a != null && a.data === b.data && a.updatedAt === b.updatedAt && a.unit === b.unit && a.entity === b.entity;
}

/**
 * {@link resolveHeldUnitPayload} for a surface whose candidate is built by the page (a strip
 * picked from a live payload or a stored snapshot). `key` names the request (its unit and
 * whatever else selects it); `refetch` is run when the requested copy is older than the one shown.
 */
export function useHeldUnitValue<T>(opts: {
  candidate: UnitCandidate<T> | undefined;
  fallback?: T;
  pending: boolean;
  unit: DisplayUnit;
  entity: string;
  key: string;
  enabled?: boolean;
  refetch?: () => Promise<unknown>;
}): HeldUnitPayload<T> {
  const { key } = opts;
  const [shown, setShown] = useState<ShownUnitPayload<T> | null>(null);
  const [settled, setSettled] = useState<{ key: string; against: number } | null>(null);
  const step = resolveHeldUnitPayload({
    candidate: opts.candidate,
    fallback: opts.fallback,
    pending: opts.pending,
    unit: opts.unit,
    entity: opts.entity,
    enabled: opts.enabled ?? true,
    shown,
    refetchSettledAgainst: settled?.key === key ? settled.against : null,
  });
  // Derived during render (React re-runs this render before committing it): the first frame of
  // a switch already compares against what was on screen, so a stale copy never flashes.
  if (step.record && !sameRecord(shown, step.record)) setShown(step.record);

  const against = step.refetchAgainst;
  const refetch = opts.refetch;
  useEffect(() => {
    if (against == null || !refetch) return;
    void refetch().finally(() => setSettled({ key, against }));
    // Once per (request, held timestamp): a re-render while it runs must not refetch again.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, against]);

  return { data: step.data, held: step.held, loading: step.loading, live: step.live };
}

/**
 * {@link useHeldUnitValue} over a display-unit query: the candidate is the query's own data (not a
 * placeholder), the fallback its same-entity placeholder, the entity the key's declared entity
 * part (`keys.ts`), and an older copy is refetched through the query itself.
 */
export function useHeldUnitQuery<T>(
  query: Pick<UseQueryResult<T>, "data" | "isPending" | "isPlaceholderData" | "dataUpdatedAt" | "refetch">,
  opts: { queryKey: readonly unknown[]; unit: DisplayUnit; enabled?: boolean }
): HeldUnitPayload<T> {
  const { queryKey } = opts;
  const own = !query.isPlaceholderData && query.data !== undefined ? query.data : undefined;
  return useHeldUnitValue({
    candidate: own !== undefined ? { data: own, updatedAt: query.dataUpdatedAt } : undefined,
    fallback: query.isPlaceholderData ? query.data : undefined,
    pending: query.isPending,
    unit: opts.unit,
    entity: hashKey(queryKey.slice(0, entityKeyLength(queryKey))),
    key: hashKey([...queryKey]),
    enabled: opts.enabled,
    // Joins a fetch already in flight (its data is newer than what is shown) instead of restarting it.
    refetch: () => query.refetch({ cancelRefetch: false }),
  });
}

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { hashKey, QueryClient, QueryObserver } from "@tanstack/react-query";
import { shareKeepingLiveInputs } from "../liveInputs";
import { entityKeyLength, queryKeys } from "./keys";
import {
  contentChangedAt,
  fetchedAt,
  initialHeldUnitState,
  settleHeldUnit,
  stepHeldUnit,
  trackFetchTimes,
  type HeldUnitInput,
  type HeldUnitState,
  type HeldUnitView,
} from "./heldUnitPayload";

/*
 * The hook (`useHeldUnitQuery`'s `useHeldUnitValue`) is a thin shell over `stepHeldUnit` / `settleHeldUnit`: it keeps
 * the state, applies a changed state during render, and runs the requested refetch once per
 * (key, against), settling it per key. The client has no DOM test setup, so these tests drive
 * those two functions the same way over a real QueryClient (the app's structural sharing) and
 * real fetches, with the clock set before each action.
 */

type List = { unit: string; rows: string[] };

function client() {
  const qc = new QueryClient({
    defaultOptions: { queries: { structuralSharing: shareKeepingLiveInputs, retry: false } },
  });
  trackFetchTimes(qc);
  return qc;
}

/** One surface (a group page's bundle) over a QueryObserver, driven like the hook. */
function surface(qc: QueryClient, fetchList: (unit: string) => Promise<List>, group = "brokerage") {
  let fetches = 0;
  const optionsFor = (g: string, unit: string) => ({
    queryKey: queryKeys.portfolioGroup(g, unit),
    queryFn: () => {
      fetches += 1;
      return fetchList(unit);
    },
    // React-query calls every copy fresh: only the hold's own rule refetches.
    staleTime: Infinity,
  });
  let current = { group, unit: "usd" };
  const observer = new QueryObserver<List, Error, List, List, readonly unknown[]>(qc, optionsFor(group, "usd"));
  const unsubscribe = observer.subscribe(() => {});
  let state: HeldUnitState<List> = initialHeldUnitState();
  const started = new Set<string>();
  const inFlight: Promise<unknown>[] = [];

  const step = (): HeldUnitView<List> => {
    const r = observer.getCurrentResult();
    const queryKey = queryKeys.portfolioGroup(current.group, current.unit);
    const key = hashKey(queryKey);
    const own = r.data !== undefined && !r.isPlaceholderData ? r.data : undefined;
    const out = stepHeldUnit(state, {
      candidate: own !== undefined ? { data: own, updatedAt: fetchedAt(qc, queryKey) } : undefined,
      pending: r.isPending,
      error: r.error,
      unit: current.unit,
      entity: hashKey(queryKey.slice(0, entityKeyLength(queryKey))),
      key,
      enabled: true,
      canRefetch: true,
    });
    state = out.state;
    const against = out.refetchAgainst;
    if (against != null && !started.has(`${key}|${against}`)) {
      started.add(`${key}|${against}`);
      inFlight.push(
        observer.refetch({ cancelRefetch: false }).finally(() => {
          state = settleHeldUnit(state, key, against);
        })
      );
    }
    return out.view;
  };

  return {
    show(unit: string, g = current.group) {
      current = { group: g, unit };
      observer.setOptions(optionsFor(g, unit));
      return step();
    },
    step,
    /** Lets every fetch in flight land, then renders again. */
    async settle() {
      for (let i = 0; i < 20; i++) {
        await Promise.all(inFlight.splice(0));
        await new Promise((r) => setTimeout(r, 0));
        if (observer.getCurrentResult().fetchStatus === "idle" && inFlight.length === 0) break;
      }
      return step();
    },
    refetchShown: () => observer.refetch(),
    get fetches() {
      return fetches;
    },
    dispose: unsubscribe,
  };
}

function server(initial: Record<string, string[]>) {
  const rows: Record<string, string[]> = { ...initial };
  const failing = new Set<string>();
  return {
    rows,
    failing,
    fetch: async (unit: string): Promise<List> => {
      if (failing.has(unit)) throw new Error(`${unit} down`);
      if (!rows[unit]) return new Promise<List>(() => {});
      return { unit, rows: [...rows[unit]] };
    },
  };
}

const at = (t: number) => vi.setSystemTime(t);

describe("stepHeldUnit over react-query, real fetch order", () => {
  let qc: QueryClient;
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    qc = client();
  });
  afterEach(() => {
    qc.clear();
    vi.useRealTimers();
  });

  it("toggling between unchanged payloads is instant after the first round trip each way", async () => {
    const srv = server({ usd: ["a"], clp: ["a"] });
    const s = surface(qc, srv.fetch);
    at(1_000);
    s.step();
    expect(await s.settle()).toMatchObject({ data: { unit: "usd" }, held: false });

    at(2_000);
    expect(s.show("clp")).toMatchObject({ data: { unit: "usd" }, held: true, loading: true });
    expect(await s.settle()).toMatchObject({ data: { unit: "clp" }, held: false });

    // The clp content is newer than the usd copy: one refetch of usd, which comes back equal.
    at(3_000);
    expect(s.show("usd")).toMatchObject({ data: { unit: "clp" }, held: true });
    expect(await s.settle()).toMatchObject({ data: { unit: "usd" }, held: false });
    expect(s.fetches).toBe(3);

    // From here on nothing changed: every toggle shows the cached copy at once, no fetch.
    for (const [t, unit] of [[4_000, "clp"], [5_000, "usd"], [6_000, "clp"], [7_000, "usd"]] as const) {
      at(t);
      expect(s.show(unit)).toMatchObject({ data: { unit }, held: false, loading: false });
    }
    await s.settle();
    expect(s.fetches).toBe(3);

    // A background refetch of the shown key with equal content keeps the fast path.
    at(8_000);
    await s.refetchShown();
    s.step();
    at(9_000);
    expect(s.show("clp")).toMatchObject({ data: { unit: "clp" }, held: false });
    expect(s.fetches).toBe(4);
    s.dispose();
  });

  it("a refetch that changes the shown content makes the other unit's copy older", async () => {
    const srv = server({ usd: ["a"], clp: ["a"] });
    const s = surface(qc, srv.fetch);
    at(1_000);
    s.step();
    await s.settle();
    at(2_000);
    s.show("clp");
    await s.settle();
    at(3_000);
    s.show("usd");
    await s.settle();

    at(4_000);
    srv.rows.usd = ["b", "a"];
    srv.rows.clp = ["b", "a"];
    await s.refetchShown();
    expect(s.step().data?.rows).toEqual(["b", "a"]);

    at(5_000);
    const clp = s.show("clp");
    expect(clp).toMatchObject({ data: { unit: "usd", rows: ["b", "a"] }, held: true, loading: true });
    expect(await s.settle()).toMatchObject({ data: { unit: "clp", rows: ["b", "a"] }, held: false });
    s.dispose();
  });

  it("[a b c]usd → [d a b c]clp → usd never shows [a b c] again", async () => {
    const srv = server({ usd: ["a", "b", "c"], clp: ["a", "b", "c"] });
    const s = surface(qc, srv.fetch);
    at(1_000);
    s.step();
    expect((await s.settle()).data?.rows).toEqual(["a", "b", "c"]);

    srv.rows.usd = ["d", "a", "b", "c"];
    srv.rows.clp = ["d", "a", "b", "c"];
    at(2_000);
    s.show("clp");
    expect((await s.settle()).data).toEqual({ unit: "clp", rows: ["d", "a", "b", "c"] });

    at(3_000);
    const back = s.show("usd");
    expect(back.data).toEqual({ unit: "clp", rows: ["d", "a", "b", "c"] });
    expect(back.live).toBeUndefined();
    expect((await s.settle()).data).toEqual({ unit: "usd", rows: ["d", "a", "b", "c"] });
    s.dispose();
  });

  it("an in-place patch of every unit's copy never makes the old one look fresh", async () => {
    const srv = server({ usd: ["a", "b", "c"], clp: ["a", "b", "c"] });
    const s = surface(qc, srv.fetch);
    at(1_000);
    s.step();
    await s.settle();
    srv.rows.usd = ["d", "a", "b", "c"];
    srv.rows.clp = ["d", "a", "b", "c"];
    at(2_000);
    s.show("clp");
    await s.settle();

    // An optimistic edit patches both copies (same object back for the usd one) at 3 000.
    at(3_000);
    qc.setQueriesData<List>({ queryKey: queryKeys.portfolioGroupAll() }, (old) =>
      old && old.unit === "clp" ? { ...old, rows: [...old.rows] } : old
    );
    expect(qc.getQueryState(queryKeys.portfolioGroup("brokerage", "usd"))?.dataUpdatedAt).toBe(3_000);
    expect(fetchedAt(qc, queryKeys.portfolioGroup("brokerage", "usd"))).toBe(1_000);
    s.step();

    at(4_000);
    const back = s.show("usd");
    expect(back).toMatchObject({ data: { unit: "clp" }, held: true, loading: true });
    expect((await s.settle()).data).toEqual({ unit: "usd", rows: ["d", "a", "b", "c"] });
    s.dispose();
  });

  it("clp → usd (pending) → eur (older copy) holds the clp payload, in clp", async () => {
    const srv = server({ eur: ["e"], clp: ["c"] });
    const s = surface(qc, srv.fetch);
    at(1_000);
    s.show("eur");
    await s.settle();
    at(2_000);
    s.show("clp");
    await s.settle();

    at(3_000);
    expect(s.show("usd")).toMatchObject({ data: { unit: "clp" }, held: true, loading: true });
    at(3_100);
    const eur = s.show("eur");
    expect(eur.data?.unit).toBe("clp");
    expect(eur).toMatchObject({ held: true, loading: true });
    expect(await s.settle()).toMatchObject({ data: { unit: "eur" }, held: false });
    s.dispose();
  });

  it("a failed first fetch in the new unit ends the hold and reports its error", async () => {
    const srv = server({ clp: ["c"], usd: ["u"] });
    srv.failing.add("usd");
    const s = surface(qc, srv.fetch);
    at(1_000);
    s.show("clp");
    await s.settle();
    at(2_000);
    expect(s.show("usd")).toMatchObject({ data: { unit: "clp" }, held: true });
    const failed = await s.settle();
    expect(failed).toMatchObject({ data: undefined, held: false, loading: false });
    expect(failed.error).toBeInstanceOf(Error);
    s.dispose();
  });

  it("a failed forced refetch shows the older copy of the target unit, undimmed, with no error", async () => {
    const srv = server({ eur: ["e"], clp: ["c"] });
    const s = surface(qc, srv.fetch);
    at(1_000);
    s.show("eur");
    await s.settle();
    at(2_000);
    s.show("clp");
    await s.settle();

    srv.failing.add("eur");
    at(3_000);
    expect(s.show("eur").held).toBe(true);
    expect(await s.settle()).toMatchObject({
      data: { unit: "eur", rows: ["e"] },
      held: false,
      loading: false,
      error: null,
    });
    s.dispose();
  });

  it("another entity holds nothing", async () => {
    const srv = server({ usd: ["b"] });
    const s = surface(qc, srv.fetch);
    at(1_000);
    s.step();
    await s.settle();
    expect(s.show("usd", "retirement")).toMatchObject({ data: undefined, held: false, loading: true });
    s.dispose();
  });
});

describe("stepHeldUnit", () => {
  const input = (over: Partial<HeldUnitInput<List>>): HeldUnitInput<List> => ({
    candidate: undefined,
    pending: false,
    error: null,
    unit: "usd",
    entity: "e",
    key: "k-usd",
    enabled: true,
    canRefetch: true,
    ...over,
  });
  /** A state that shows `data`, its content first seen at `t`, requested in its unit. */
  const showing = (data: List, t: number): HeldUnitState<List> =>
    stepHeldUnit(initialHeldUnitState<List>(), input({ candidate: { data, updatedAt: t }, unit: data.unit })).state;

  it("a surface hidden for a while holds what it last drew when it is drawn again", () => {
    const shown = showing({ unit: "clp", rows: ["d"] }, 10);
    const off = stepHeldUnit(shown, input({ enabled: false, pending: true, unit: "clp", key: "k-clp" }));
    expect(off.view.data).toBeUndefined();
    const back = stepHeldUnit(off.state, input({ pending: true }));
    expect(back.view).toMatchObject({ data: { unit: "clp", rows: ["d"] }, held: true, unit: "clp", loading: true });
    expect(stepHeldUnit(off.state, input({ pending: true, entity: "other" })).view.data).toBeUndefined();
  });

  it("a failed first fetch keeps its error while it retries, until one succeeds", () => {
    const boom = new Error("down");
    const failed = stepHeldUnit(initialHeldUnitState<List>(), input({ error: boom }));
    expect(failed.view.error).toBe(boom);
    const retry = stepHeldUnit(failed.state, input({ pending: true }));
    expect(retry.view).toMatchObject({ data: undefined, loading: false, error: boom });
    expect(stepHeldUnit(failed.state, input({ pending: true, key: "k-eur" })).view).toMatchObject({ loading: true, error: null });
    const ok = stepHeldUnit(retry.state, input({ candidate: { data: { unit: "usd", rows: ["y"] }, updatedAt: 20 } }));
    expect(ok.state.failed).toBeNull();
    expect(stepHeldUnit(ok.state, input({ pending: true })).view.error).toBeNull();
  });

  it("remembers only the newest settled refetches", () => {
    let state = initialHeldUnitState<List>();
    for (let i = 0; i < 20; i++) state = settleHeldUnit(state, `k-${i}`, i);
    expect(state.settled.size).toBe(8);
    expect(state.settled.get("k-19")).toBe(19);
    expect(state.settled.has("k-0")).toBe(false);
  });

  it("a request that cannot be refetched shows its older copy", () => {
    const shown = showing({ unit: "clp", rows: ["x"] }, 10);
    const older = { data: { unit: "usd", rows: ["y"] }, updatedAt: 5 };
    expect(stepHeldUnit(shown, input({ candidate: older, canRefetch: false })).view).toMatchObject({
      data: older.data,
      held: false,
      loading: false,
    });
    expect(stepHeldUnit(shown, input({ candidate: older })).refetchAgainst).toBe(10);
  });

  it("a late settle of an earlier key never undoes a later key's", () => {
    const shown = showing({ unit: "clp", rows: ["x"] }, 10);
    const older = { data: { unit: "usd", rows: ["y"] }, updatedAt: 5 };
    // usd held (against 10) and settled, then the eur refetch from before settles late.
    const settled = settleHeldUnit(settleHeldUnit(shown, "k-usd", 10), "k-eur", 10);
    expect(stepHeldUnit(settled, input({ candidate: older })).view).toMatchObject({ data: older.data, held: false });
  });

  it("a stored copy (updated at 0) paints an empty surface, never replaces one on screen, never is live", () => {
    const stored = { data: { unit: "usd", rows: ["s"] }, updatedAt: 0 };
    expect(stepHeldUnit(initialHeldUnitState<List>(), input({ candidate: stored })).view).toMatchObject({
      data: stored.data,
      held: false,
      live: undefined,
    });
    const shown = showing({ unit: "clp", rows: ["live"] }, 10);
    expect(stepHeldUnit(shown, input({ candidate: stored })).view).toMatchObject({ held: true, loading: true });
  });

  it("a period or range change of the same unit shows its cached copy as it is", () => {
    const shown = showing({ unit: "usd", rows: ["90d"] }, 10);
    const cached = { data: { unit: "usd", rows: ["1y"] }, updatedAt: 1 };
    expect(stepHeldUnit(shown, input({ candidate: cached, key: "k-usd-1y" })).view.data).toBe(cached.data);
  });

  it("keeps the same state object while nothing changed (no render loop)", () => {
    const data = { unit: "usd", rows: ["x"] };
    const shown = showing(data, 10);
    expect(stepHeldUnit(shown, input({ candidate: { data, updatedAt: 20 } })).state).toBe(shown);
  });
});

describe("contentChangedAt", () => {
  it("dates content by its first fetch, a stored copy by the first fetch that confirms it", () => {
    const fetched = { v: 1 };
    expect(contentChangedAt(fetched, 5)).toBe(5);
    expect(contentChangedAt(fetched, 9)).toBe(5);
    const stored = { v: 2 };
    expect(contentChangedAt(stored, 0)).toBe(0);
    expect(contentChangedAt(stored, 7)).toBe(7);
    expect(contentChangedAt(stored, 8)).toBe(7);
  });
});

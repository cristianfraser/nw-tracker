import { afterEach, describe, expect, it } from "vitest";
import { hashKey, QueryClient, QueryObserver } from "@tanstack/react-query";
import { keepPreviousDataSameEntity } from "./displayUnitQueries";
import { entityKeyLength, queryKeys } from "./keys";
import { resolveHeldUnitPayload, type HeldUnitStep, type ShownUnitPayload } from "./heldUnitPayload";

type List = { unit: string; rows: string[] };

/**
 * One surface over a real QueryObserver, stepped the way `useHeldUnitQuery` steps a render: the
 * last shown record is kept, and a requested forced refetch is run (and awaited) by `settle`.
 */
function surface(qc: QueryClient, fetchRows: (unit: string) => Promise<List>, group = "brokerage") {
  const keyOf = (g: string, unit: string) => queryKeys.portfolioGroup(g, unit);
  const optionsFor = (g: string, unit: string) => {
    const queryKey = keyOf(g, unit);
    return {
      queryKey,
      queryFn: () => fetchRows(unit),
      staleTime: Infinity,
      placeholderData: keepPreviousDataSameEntity(queryKey, entityKeyLength(queryKey)),
    };
  };
  let current = { group, unit: "usd" };
  const observer = new QueryObserver<List, Error, List, List, readonly unknown[]>(qc, optionsFor(group, "usd"));
  const unsubscribe = observer.subscribe(() => {});
  let shown: ShownUnitPayload<List> | null = null;
  let settled: { key: string; against: number } | null = null;
  let pendingRefetch: { key: string; against: number } | null = null;

  const step = (): HeldUnitStep<List> => {
    const r = observer.getCurrentResult();
    const queryKey = keyOf(current.group, current.unit);
    const key = hashKey([...queryKey]);
    const own = !r.isPlaceholderData && r.data !== undefined ? r.data : undefined;
    const out = resolveHeldUnitPayload({
      candidate: own !== undefined ? { data: own, updatedAt: r.dataUpdatedAt } : undefined,
      fallback: r.isPlaceholderData ? r.data : undefined,
      pending: r.isPending,
      unit: current.unit,
      entity: hashKey(queryKey.slice(0, entityKeyLength(queryKey))),
      enabled: true,
      shown,
      refetchSettledAgainst: settled?.key === key ? settled.against : null,
    });
    if (out.record) shown = out.record;
    pendingRefetch = out.refetchAgainst != null ? { key, against: out.refetchAgainst } : null;
    return out;
  };

  return {
    show(unit: string, g = current.group) {
      current = { group: g, unit };
      observer.setOptions(optionsFor(g, unit));
      return step();
    },
    step,
    /** Runs the forced refetch the last step asked for, as the hook's effect does. */
    async settle() {
      const req = pendingRefetch;
      if (!req) throw new Error("no refetch requested");
      await observer.refetch({ cancelRefetch: false });
      settled = req;
      return step();
    },
    dispose: unsubscribe,
  };
}

const list = (unit: string, ...rows: string[]): List => ({ unit, rows });

describe("resolveHeldUnitPayload over react-query", () => {
  let qc: QueryClient;
  afterEach(() => qc.clear());

  it("never steps back to an older copy of the target unit: [a b c]usd → [d a b c]clp → usd", async () => {
    qc = new QueryClient();
    qc.setQueryData(queryKeys.portfolioGroup("brokerage", "usd"), list("usd", "a", "b", "c"), { updatedAt: 1_000 });
    qc.setQueryData(queryKeys.portfolioGroup("brokerage", "clp"), list("clp", "d", "a", "b", "c"), { updatedAt: 2_000 });
    const s = surface(qc, async (unit) => list(unit, "d", "a", "b", "c"));

    const first = s.step();
    expect(first.data).toEqual(list("usd", "a", "b", "c"));
    expect(first.loading).toBe(false);

    const clp = s.show("clp");
    expect(clp.data).toEqual(list("clp", "d", "a", "b", "c"));
    expect(clp.live).toBe(clp.data);

    // The cached usd copy is older than the clp list on screen: the clp list stays, dimmed, and
    // the usd copy is refetched (react-query still calls it fresh).
    const back = s.show("usd");
    expect(back.data).toEqual(list("clp", "d", "a", "b", "c"));
    expect(back).toMatchObject({ held: true, loading: true, live: undefined });
    expect(back.refetchAgainst).toBe(2_000);

    const fresh = await s.settle();
    expect(fresh.data).toEqual(list("usd", "d", "a", "b", "c"));
    expect(fresh).toMatchObject({ held: false, loading: false });
    s.dispose();
  });

  it("switches at once to a copy at least as new (the fast path)", () => {
    qc = new QueryClient();
    qc.setQueryData(queryKeys.portfolioGroup("brokerage", "usd"), list("usd", "x"), { updatedAt: 1_000 });
    qc.setQueryData(queryKeys.portfolioGroup("brokerage", "clp"), list("clp", "x"), { updatedAt: 3_000 });
    const s = surface(qc, async () => {
      throw new Error("nothing is fetched");
    });
    s.step();
    const clp = s.show("clp");
    expect(clp).toMatchObject({ data: list("clp", "x"), held: false, loading: false, refetchAgainst: null });
    s.dispose();
  });

  it("clp → usd (pending) → eur holds the clp payload, labelled clp, not usd", () => {
    qc = new QueryClient();
    qc.setQueryData(queryKeys.portfolioGroup("brokerage", "clp"), list("clp", "c"), { updatedAt: 2_000 });
    qc.setQueryData(queryKeys.portfolioGroup("brokerage", "eur"), list("eur", "old"), { updatedAt: 1_500 });
    const s = surface(qc, () => new Promise<List>(() => {}));
    s.show("clp");

    const usd = s.show("usd");
    expect(usd).toMatchObject({ data: list("clp", "c"), held: true, loading: true });

    const eur = s.show("eur");
    expect(eur.data?.unit).toBe("clp");
    expect(eur).toMatchObject({ held: true, loading: true, refetchAgainst: 2_000 });
    s.dispose();
  });

  it("a newer target copy after a pending unit is shown at once", () => {
    qc = new QueryClient();
    qc.setQueryData(queryKeys.portfolioGroup("brokerage", "clp"), list("clp", "c"), { updatedAt: 2_000 });
    qc.setQueryData(queryKeys.portfolioGroup("brokerage", "eur"), list("eur", "e"), { updatedAt: 2_500 });
    const s = surface(qc, () => new Promise<List>(() => {}));
    s.show("clp");
    s.show("usd");
    expect(s.show("eur")).toMatchObject({ data: list("eur", "e"), held: false, loading: false });
    s.dispose();
  });

  it("another entity holds nothing", () => {
    qc = new QueryClient();
    qc.setQueryData(queryKeys.portfolioGroup("brokerage", "usd"), list("usd", "b"), { updatedAt: 2_000 });
    const s = surface(qc, () => new Promise<List>(() => {}));
    s.step();
    const other = s.show("usd", "retirement");
    expect(other).toMatchObject({ data: undefined, held: false, loading: true });
    s.dispose();
  });

  it("a background refetch of the shown key is shown, never held as «older»", async () => {
    qc = new QueryClient();
    qc.setQueryData(queryKeys.portfolioGroup("brokerage", "usd"), list("usd", "a"), { updatedAt: 2_000 });
    const s = surface(qc, async (unit) => list(unit, "b", "a"));
    s.step();
    qc.setQueryData(queryKeys.portfolioGroup("brokerage", "usd"), list("usd", "b", "a"), { updatedAt: 3_000 });
    expect(s.step()).toMatchObject({ data: list("usd", "b", "a"), held: false, loading: false });
    s.dispose();
  });

  it("shows the older copy once its forced refetch has failed (never dims forever)", async () => {
    qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    qc.setQueryData(queryKeys.portfolioGroup("brokerage", "usd"), list("usd", "a"), { updatedAt: 1_000 });
    qc.setQueryData(queryKeys.portfolioGroup("brokerage", "clp"), list("clp", "b"), { updatedAt: 2_000 });
    const s = surface(qc, async () => {
      throw new Error("server down");
    });
    s.step();
    s.show("clp");
    expect(s.show("usd").held).toBe(true);
    const after = await s.settle();
    expect(after).toMatchObject({ data: list("usd", "a"), held: false, loading: false });
    s.dispose();
  });
});

describe("resolveHeldUnitPayload", () => {
  const base = {
    fallback: undefined,
    pending: false,
    unit: "usd",
    entity: "e",
    enabled: true,
    refetchSettledAgainst: null,
  };

  it("a stored copy (updated at 0) paints an empty surface but never replaces one on screen", () => {
    const stored = { data: list("usd", "s"), updatedAt: 0 };
    expect(resolveHeldUnitPayload({ ...base, candidate: stored, shown: null }).data).toBe(stored.data);
    const onScreen: ShownUnitPayload<List> = { data: list("clp", "live"), updatedAt: 5, unit: "clp", entity: "e" };
    expect(resolveHeldUnitPayload({ ...base, candidate: stored, shown: onScreen })).toMatchObject({
      data: onScreen.data,
      held: true,
      loading: true,
    });
  });

  it("a period or range change of the same unit shows its cached copy as it is", () => {
    const onScreen: ShownUnitPayload<List> = { data: list("usd", "90d"), updatedAt: 5, unit: "usd", entity: "e" };
    const cached = { data: list("usd", "1y"), updatedAt: 1 };
    expect(resolveHeldUnitPayload({ ...base, candidate: cached, shown: onScreen }).data).toBe(cached.data);
  });

  it("a disabled request never holds over its copy", () => {
    const onScreen: ShownUnitPayload<List> = { data: list("clp", "x"), updatedAt: 5, unit: "clp", entity: "e" };
    const cached = { data: list("usd", "y"), updatedAt: 1 };
    expect(resolveHeldUnitPayload({ ...base, enabled: false, candidate: cached, shown: onScreen }).data).toBe(cached.data);
  });
});

import { createElement, lazy, useEffect, useState, type ComponentType } from "react";

/**
 * Lazy chunks: what the first paint does not need loads on demand — the secondary pages, and the
 * chart engine (recharts plus the chart components the eager pages render, one chunk:
 * `components/charts/chartsBundle.ts`). The eager pages paint their layout at once and their
 * charts' frames until that chunk arrives. Every chunk registers here, and once the app has
 * painted `prefetchLazyChunks` imports them all in the browser's idle time, one at a time so
 * they never compete with the page's own requests, charts first (the page on screen waits on
 * them). After that every later navigation and every chart renders synchronously: a
 * `lazyComponent` mounted after its chunk arrived renders the module directly, with no suspend
 * tick and no fallback.
 */

type ChunkLoader = () => Promise<unknown>;

/** Hands `run` to the browser's idle time (or a test's manual trigger). */
export type IdleScheduler = (run: () => Promise<void>) => void;

export type LazyChunkRegistry = {
  /** Adds a loader once; `first` loaders run before the rest, each group in registration order. */
  register: (load: ChunkLoader, options?: { first?: boolean }) => void;
  /** Schedules one sequential pass over every registered loader; later calls do nothing. */
  prefetch: (schedule: IdleScheduler) => void;
};

export function createLazyChunkRegistry(): LazyChunkRegistry {
  const first: ChunkLoader[] = [];
  const rest: ChunkLoader[] = [];
  let scheduled = false;
  return {
    register(load, options) {
      if (first.includes(load) || rest.includes(load)) return;
      (options?.first ? first : rest).push(load);
    },
    prefetch(schedule) {
      if (scheduled) return;
      scheduled = true;
      schedule(async () => {
        // A failed import stops the pass and surfaces as an unhandled rejection; the chunk is
        // imported again by the navigation that needs it (`lazyChunk` forgets a failed import).
        for (const load of [...first, ...rest]) await load();
      });
    },
  };
}

const registry = createLazyChunkRegistry();

export const registerLazyChunk = registry.register;

/** Upper bound on the wait for an idle period before the prefetch starts anyway. */
const PREFETCH_IDLE_TIMEOUT_MS = 4000;
/** Where `requestIdleCallback` is missing (Safari): a fixed delay after the first paint. */
const PREFETCH_FALLBACK_DELAY_MS = 2000;

const scheduleWhenIdle: IdleScheduler = (run) => {
  const start = () => void run();
  if (typeof window.requestIdleCallback === "function") {
    window.requestIdleCallback(start, { timeout: PREFETCH_IDLE_TIMEOUT_MS });
  } else {
    window.setTimeout(start, PREFETCH_FALLBACK_DELAY_MS);
  }
};

export function prefetchLazyChunks(): void {
  registry.prefetch(scheduleWhenIdle);
}

/** Starts the idle prefetch once the app has mounted (call once, at the app root). */
export function useIdleChunkPrefetch(): void {
  useEffect(() => {
    prefetchLazyChunks();
  }, []);
}

export type LazyChunk<M> = {
  /** Imports the module once; after a failed import the next call tries again. */
  load: () => Promise<M>;
  /** The module once it has arrived. */
  loaded: () => M | undefined;
};

/** A registered chunk: `first` puts it ahead of the others in the idle prefetch. */
export function lazyChunk<M>(importer: () => Promise<M>, options?: { first?: boolean }): LazyChunk<M> {
  let pending: Promise<M> | null = null;
  let module: M | undefined;
  const load = () => {
    pending ??= importer().then(
      (m) => {
        module = m;
        return m;
      },
      (error: unknown) => {
        pending = null;
        throw error;
      }
    );
    return pending;
  };
  registerLazyChunk(load, options);
  return { load, loaded: () => module };
}

/**
 * A component from a lazy chunk. Mounted before the chunk arrived it suspends (React.lazy: the
 * nearest Suspense shows its fallback); mounted after, it renders the module's component
 * directly. The choice is made once per instance, so the chunk's arrival never remounts a
 * component that suspended on it.
 */
export function lazyComponent<M, P extends object>(
  chunk: LazyChunk<M>,
  pick: (module: M) => ComponentType<P>
): ComponentType<P> {
  const Lazy = lazy(async () => ({ default: pick(await chunk.load()) })) as unknown as ComponentType<P>;
  function LazyChunkComponent(props: P) {
    const [Loaded] = useState(() => {
      const module = chunk.loaded();
      return module === undefined ? undefined : pick(module);
    });
    return createElement(Loaded ?? Lazy, props);
  }
  return LazyChunkComponent;
}

import { describe, expect, it, vi } from "vitest";
import { createLazyChunkRegistry, lazyChunk, type IdleScheduler } from "./lazyChunks";

/** A scheduler that holds the pass until the test runs it. */
function manualScheduler() {
  let pending: (() => Promise<void>) | null = null;
  const schedule = vi.fn<IdleScheduler>((run) => {
    pending = run;
  });
  return { schedule, run: () => pending!() };
}

describe("lazy chunk registry", () => {
  it("imports every chunk once, one at a time, first-priority chunks ahead of the rest", async () => {
    const log: string[] = [];
    const loader = (name: string) =>
      vi.fn(async () => {
        log.push(`start ${name}`);
        await Promise.resolve();
        log.push(`end ${name}`);
      });
    const page = loader("page");
    const charts = loader("charts");
    const otherPage = loader("otherPage");
    const registry = createLazyChunkRegistry();
    registry.register(page);
    registry.register(charts, { first: true });
    registry.register(page);
    registry.register(otherPage);

    const { schedule, run } = manualScheduler();
    registry.prefetch(schedule);
    expect(log).toEqual([]);
    await run();

    expect(log).toEqual([
      "start charts",
      "end charts",
      "start page",
      "end page",
      "start otherPage",
      "end otherPage",
    ]);
    for (const load of [page, charts, otherPage]) expect(load).toHaveBeenCalledTimes(1);
  });

  it("schedules a single pass however often it is asked", () => {
    const registry = createLazyChunkRegistry();
    const { schedule } = manualScheduler();
    registry.prefetch(schedule);
    registry.prefetch(schedule);
    expect(schedule).toHaveBeenCalledTimes(1);
  });
});

describe("lazyChunk", () => {
  it("imports its module once and exposes it once it has arrived", async () => {
    const module = { Page: "page" };
    const importer = vi.fn(async () => module);
    const chunk = lazyChunk(importer);
    expect(chunk.loaded()).toBeUndefined();
    const [a, b] = await Promise.all([chunk.load(), chunk.load()]);
    expect(a).toBe(module);
    expect(b).toBe(module);
    expect(chunk.loaded()).toBe(module);
    expect(importer).toHaveBeenCalledTimes(1);
  });

  it("imports again after a failed import", async () => {
    const module = { Page: "page" };
    const importer = vi
      .fn<() => Promise<typeof module>>()
      .mockRejectedValueOnce(new Error("chunk fetch failed"))
      .mockResolvedValueOnce(module);
    const chunk = lazyChunk(importer);
    await expect(chunk.load()).rejects.toThrow("chunk fetch failed");
    expect(chunk.loaded()).toBeUndefined();
    await expect(chunk.load()).resolves.toBe(module);
    expect(importer).toHaveBeenCalledTimes(2);
  });
});

/**
 * «Something changed in the queue»: a producer that enqueued, a worker that completed. The
 * executor listens and runs a tick at once instead of waiting for its interval. A leaf module so
 * producers need not import the executor.
 */
let listener: (() => void) | null = null;

export function onJobQueueChange(fn: (() => void) | null): void {
  listener = fn;
}

export function notifyJobQueue(): void {
  listener?.();
}

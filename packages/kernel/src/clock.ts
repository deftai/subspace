/**
 * Time, as something tests can control. Every timer in the kernel goes through
 * a Clock, so a test can fake it and check timeout behaviour without waiting.
 */
export interface Clock {
  now(): number;
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export const systemClock: Clock = {
  now: () => Date.now(),
  setTimeout: (callback, ms) => {
    const handle = setTimeout(callback, ms);
    // A pending deadline must not keep a process alive on its own.
    (handle as { unref?: () => void }).unref?.();
    return handle;
  },
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

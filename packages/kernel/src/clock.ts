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
  // A deadline keeps the process alive until it fires or is cleared: someone is
  // waiting on it, and with nothing else pending (an in-process agent, a test)
  // Node would otherwise exit before the timeout is ever reported.
  setTimeout: (callback, ms) => setTimeout(callback, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

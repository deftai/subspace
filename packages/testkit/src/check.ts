/** What a conformance check found. */
export interface CheckResult {
  id: string;
  title: string;
  pass: boolean;
  /** The check could not run (e.g. the agent never asked for permission). `pass` is true. */
  skipped?: boolean;
  detail: string;
}

/** The checks that failed. */
export function failures(report: readonly CheckResult[]): CheckResult[] {
  return report.filter((r) => !r.pass);
}

/** One line per check, for logs. */
export function formatReport(report: readonly CheckResult[]): string {
  return report
    .map((r) => `${r.skipped ? 'SKIP' : r.pass ? 'PASS' : 'FAIL'}  ${r.id.padEnd(28)} ${r.title}${r.detail ? ` (${r.detail})` : ''}`)
    .join('\n');
}

/** @internal Run one check, turning a throw or a timeout into a failure. */
export async function runCheck(
  id: string,
  title: string,
  body: () => Promise<{ pass: boolean; detail: string; skipped?: boolean }>
): Promise<CheckResult> {
  try {
    const { pass, detail, skipped } = await body();
    return { id, title, pass, detail, ...(skipped ? { skipped: true } : {}) };
  } catch (error) {
    return { id, title, pass: false, detail: `threw: ${error instanceof Error ? error.message : String(error)}` };
  }
}

/** @internal Resolve with `fallback` if `promise` takes longer than `ms`. */
export function within<T, F>(promise: Promise<T>, ms: number, fallback: F): Promise<T | F> {
  return new Promise((resolve, reject) => {
    const handle = setTimeout(() => resolve(fallback), ms);
    promise.then(
      (value) => {
        clearTimeout(handle);
        resolve(value);
      },
      (error) => {
        clearTimeout(handle);
        reject(error);
      }
    );
  });
}

export const TIMED_OUT = Symbol('timed out');

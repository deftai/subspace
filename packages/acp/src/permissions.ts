import type { PermissionOption, PermissionOutcome, PermissionRequest } from './model.ts';

/**
 * How to answer an agent's permission question.
 *
 * - `'allow'` / `'reject'`: pick the agent's once-only option of that kind
 *   (or its always option if that is all it offers).
 * - `'allow_always'` / `'reject_always'`: prefer the always option.
 * - `{ optionId }`: exactly that option. It must be one the agent offered.
 * - `'cancelled'`: answer cancelled.
 *
 * Any other string is a rejection. (The type accepts any string because
 * TypeScript widens literals returned from `async` functions; unknown values
 * fail closed at run time instead.)
 */
export type PermissionDecision =
  | 'allow'
  | 'allow_always'
  | 'reject'
  | 'reject_always'
  | 'cancelled'
  | { optionId: string }
  | (string & {});

/**
 * A fixed answer, or a function deciding each request. Anything that goes
 * wrong while deciding (a throw, an unknown option id) becomes a rejection:
 * permissions fail closed.
 */
export type PermissionPolicy = 'allow' | 'reject' | PermissionHandler;

/** Decide one request. `signal` fires if the turn is cancelled while you decide. */
export type PermissionHandler = (
  request: PermissionRequest,
  signal: AbortSignal
) => PermissionDecision | Promise<PermissionDecision>;

const ALLOW = ['allow_once', 'allow_always'];

const isAllow = (option: PermissionOption) => ALLOW.includes(option.kind);

function pick(options: PermissionOption[], kinds: string[]): PermissionOption | undefined {
  for (const kind of kinds) {
    const match = options.find((o) => o.kind === kind);
    if (match) return match;
  }
  return undefined;
}

/** Turn a decision into an outcome the agent accepts. Never selects an option the agent did not offer. */
export function resolveDecision(decision: PermissionDecision, options: PermissionOption[]): PermissionOutcome {
  const selected = (option: PermissionOption | undefined): PermissionOutcome =>
    option ? { outcome: 'selected', optionId: option.optionId, allowed: isAllow(option) } : reject();
  const reject = (): PermissionOutcome => {
    const option = pick(options, ['reject_once', 'reject_always']);
    return option ? { outcome: 'selected', optionId: option.optionId, allowed: false } : { outcome: 'cancelled' };
  };

  if (decision === 'cancelled') return { outcome: 'cancelled' };
  if (decision === 'allow') return selected(pick(options, ['allow_once', 'allow_always']));
  if (decision === 'allow_always') return selected(pick(options, ['allow_always', 'allow_once']));
  if (decision === 'reject_always') {
    const option = pick(options, ['reject_always', 'reject_once']);
    return option ? { outcome: 'selected', optionId: option.optionId, allowed: false } : { outcome: 'cancelled' };
  }
  if (typeof decision === 'object' && decision && typeof decision.optionId === 'string') {
    return selected(options.find((o) => o.optionId === decision.optionId));
  }
  return reject();
}

export async function decide(
  policy: PermissionPolicy,
  request: PermissionRequest,
  signal: AbortSignal
): Promise<PermissionOutcome> {
  if (signal.aborted) return { outcome: 'cancelled' };
  if (policy === 'allow' || policy === 'reject') return resolveDecision(policy, request.options);
  try {
    const decision = await Promise.race([
      Promise.resolve(policy(request, signal)),
      new Promise<PermissionDecision>((resolve) => signal.addEventListener('abort', () => resolve('cancelled'), { once: true })),
    ]);
    return signal.aborted ? { outcome: 'cancelled' } : resolveDecision(decision, request.options);
  } catch {
    return resolveDecision('reject', request.options);
  }
}

export interface RetryDecision {
  retry: boolean;
  /** Server-requested delay (e.g. from `Retry-After`), overriding the backoff. */
  delayMs?: number;
}

export interface RetryPolicy {
  maxRetries: number;
  baseDelayMs: number;
  maxDelayMs: number;
  classify: (error: unknown) => RetryDecision;
  sleep: (ms: number) => Promise<void>;
  /** Returns a number in [0, 1). Injected for deterministic tests. */
  random: () => number;
}

/** Exponential backoff with full jitter: delay = random × min(max, base × 2^attempt). */
export async function withRetry<T>(operation: () => Promise<T>, policy: RetryPolicy): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await operation();
    } catch (error) {
      const decision = policy.classify(error);
      if (!decision.retry || attempt >= policy.maxRetries) throw error;
      const backoff = Math.min(policy.maxDelayMs, policy.baseDelayMs * 2 ** attempt);
      await policy.sleep(decision.delayMs ?? policy.random() * backoff);
    }
  }
}

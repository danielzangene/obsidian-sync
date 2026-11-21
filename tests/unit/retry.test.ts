import { describe, expect, it } from "vitest";
import { withRetry, type RetryPolicy } from "../../src/lib/retry";

function policy(overrides: Partial<RetryPolicy> = {}): RetryPolicy & { delays: number[] } {
  const delays: number[] = [];
  return {
    maxRetries: 3,
    baseDelayMs: 500,
    maxDelayMs: 8000,
    classify: () => ({ retry: true }),
    sleep: (ms) => {
      delays.push(ms);
      return Promise.resolve();
    },
    random: () => 1,
    ...overrides,
    delays,
  };
}

describe("withRetry", () => {
  it("retries with exponential backoff, then succeeds", async () => {
    const p = policy();
    let calls = 0;
    const result = await withRetry(() => {
      calls++;
      return calls < 3 ? Promise.reject(new Error("x")) : Promise.resolve("ok");
    }, p);
    expect(result).toBe("ok");
    expect(p.delays).toEqual([500, 1000]);
  });

  it("gives up after maxRetries (4 attempts in total)", async () => {
    const p = policy();
    let calls = 0;
    await expect(
      withRetry(() => {
        calls++;
        return Promise.reject(new Error("down"));
      }, p),
    ).rejects.toThrow("down");
    expect(calls).toBe(4);
    expect(p.delays).toEqual([500, 1000, 2000]);
  });

  it("does not retry errors classified as permanent", async () => {
    const p = policy({ classify: () => ({ retry: false }) });
    let calls = 0;
    await expect(
      withRetry(() => {
        calls++;
        return Promise.reject(new Error("bad request"));
      }, p),
    ).rejects.toThrow();
    expect(calls).toBe(1);
  });

  it("uses the server-requested delay when given", async () => {
    const p = policy({ classify: () => ({ retry: true, delayMs: 1234 }) });
    let calls = 0;
    await withRetry(() => (++calls < 2 ? Promise.reject(new Error("429")) : Promise.resolve()), p);
    expect(p.delays).toEqual([1234]);
  });

  it("applies full jitter and caps the delay", async () => {
    const p = policy({ random: () => 0.5, maxRetries: 6, maxDelayMs: 2000 });
    let calls = 0;
    await withRetry(() => (++calls < 6 ? Promise.reject(new Error("x")) : Promise.resolve()), p);
    expect(p.delays).toEqual([250, 500, 1000, 1000, 1000]);
  });
});

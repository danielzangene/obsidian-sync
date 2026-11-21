import { describe, expect, it } from "vitest";
import { runPool } from "../../src/lib/pool";

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("runPool", () => {
  it("never runs more than the limit at once and runs every item", async () => {
    let active = 0;
    let peak = 0;
    const done: number[] = [];
    await runPool([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 4, async (n) => {
      active++;
      peak = Math.max(peak, active);
      await tick();
      done.push(n);
      active--;
    });
    expect(peak).toBe(4);
    expect(done.sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  });

  it("stops starting new items after a failure and rethrows it", async () => {
    const started: number[] = [];
    const run = runPool([1, 2, 3, 4, 5], 1, async (n) => {
      started.push(n);
      await tick();
      if (n === 2) throw new Error("boom");
    });
    await expect(run).rejects.toThrow("boom");
    expect(started).toEqual([1, 2]);
  });

  it("handles an empty list", async () => {
    await expect(runPool([], 4, () => Promise.resolve())).resolves.toBeUndefined();
  });
});

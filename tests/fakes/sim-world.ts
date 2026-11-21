import type { Clock } from "../../src/ports/clock";

/** Simulated "real" time shared by the fake Drive and all devices. */
export class SimWorld {
  constructor(public now = Date.parse("2026-11-16T09:00:00.000Z")) {}

  advance(ms: number): void {
    this.now += ms;
  }
}

/** A device clock: world time plus a (possibly wrong) offset. Sleeping advances world time. */
export class DeviceClock implements Clock {
  constructor(
    private readonly world: SimWorld,
    public offsetMs = 0,
  ) {}

  now(): number {
    return this.world.now + this.offsetMs;
  }

  sleep(ms: number): Promise<void> {
    this.world.advance(ms);
    return Promise.resolve();
  }
}

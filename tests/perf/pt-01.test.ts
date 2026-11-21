import { describe, expect, it } from "vitest";
import { Device } from "../fakes/device";
import { FakeDrive } from "../fakes/fake-drive";
import { SimWorld } from "../fakes/sim-world";

describe("PT-01 (PRD NFR-2)", () => {
  it("syncs an unchanged 2,000-note vault in under 10 s with a constant number of requests", async () => {
    const world = new SimWorld();
    const drive = new FakeDrive(world);
    const device = new Device(world, drive);
    for (let i = 0; i < 2000; i++) {
      device.files.put(
        `folder-${i % 40}/note-${i}.md`,
        `# Note ${i}\n\n${"lorem ipsum ".repeat(40)}`,
      );
    }
    expect((await device.sync()).status).toBe("done");
    // The next run re-lists files uploaded inside the 5-minute query overlap (a one-off after a
    // bulk upload); measure the steady state after that.
    world.advance(10 * 60_000);
    expect((await device.sync()).status).toBe("done");
    world.advance(60_000);

    drive.latencyMs = 50; // realistic round trip
    const requestsBefore = drive.requests.length;
    const simulatedStart = world.now;
    const wallStart = performance.now();

    const report = await device.sync();

    const requests = drive.requests.length - requestsBefore;
    const simulatedMs = world.now - simulatedStart;
    const wallMs = performance.now() - wallStart;
    expect(report).toMatchObject({ status: "done", uploaded: 0, downloaded: 0 });
    // Vault folder check + one change query (the access token is still cached).
    expect(requests).toBeLessThanOrEqual(3);
    expect(simulatedMs + wallMs).toBeLessThan(10_000);
  });
});

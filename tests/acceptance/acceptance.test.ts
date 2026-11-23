import { describe, expect, it } from "vitest";
import { EPOCH_ISO } from "../../src/domain/constants";
import { NetworkError } from "../../src/ports/http-transport";
import { Device } from "../fakes/device";
import { FakeDrive } from "../fakes/fake-drive";
import { SimWorld } from "../fakes/sim-world";

const VAULT = "obsidian/Vault";
const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;

function setup() {
  const world = new SimWorld();
  const drive = new FakeDrive(world);
  const device = (options?: ConstructorParameters<typeof Device>[2]) =>
    new Device(world, drive, options);
  return { world, drive, device };
}

/** Two devices sharing one vault, both fully synced with `files`. */
async function twoSyncedDevices(files: Record<string, string> = { "n.md": "v1" }) {
  const env = setup();
  const a = env.device();
  const b = env.device();
  for (const [path, text] of Object.entries(files)) a.files.put(path, text);
  expect((await a.sync()).status).toBe("done");
  env.world.advance(MINUTE);
  expect((await b.sync()).status).toBe("done");
  env.world.advance(MINUTE);
  return { ...env, a, b };
}

const conflictCopies = (device: Device) =>
  device.files.paths().filter((p) => p.includes("(conflict"));

describe("PRD §9 acceptance criteria", () => {
  it("AT-01: first sync creates obsidian/<vault> and uploads everything", async () => {
    const { drive, device } = setup();
    const a = device();
    a.files.put("a.md", "alpha");
    a.files.put("notes/b.md", "beta");

    const report = await a.sync();

    expect(report).toMatchObject({ status: "done", uploaded: 2, downloaded: 0, failed: [] });
    expect(drive.snapshot(VAULT)).toEqual({ "a.md": "alpha", "notes/b.md": "beta" });
    expect(a.lastSyncTime).not.toBe(EPOCH_ISO);
  });

  it("AT-02: an existing Obsidian/ folder is reused regardless of case", async () => {
    const { drive, device } = setup();
    drive.mkdirs("Obsidian");
    const a = device();
    a.files.put("a.md", "alpha");

    await a.sync();

    expect(drive.countFolders("", "Obsidian")).toBe(1);
    expect(drive.countFolders("", "obsidian")).toBe(0);
    expect(drive.snapshot("Obsidian/Vault")).toEqual({ "a.md": "alpha" });
  });

  it("AT-03: a sync with no changes transfers nothing and advances Last successful sync", async () => {
    const { world, device } = setup();
    const a = device();
    a.files.put("a.md", "alpha");
    await a.sync();
    const previous = a.lastSyncTime;
    world.advance(10 * MINUTE);
    const startedAt = world.now;

    const report = await a.sync();

    expect(report).toMatchObject({ status: "done", uploaded: 0, downloaded: 0, conflicts: 0 });
    const last = Date.parse(a.lastSyncTime);
    expect(last).toBeGreaterThan(Date.parse(previous));
    // The run's start (server time, second precision), not its end.
    expect(last).toBeLessThanOrEqual(startedAt + 1000);
    expect(last).toBeGreaterThan(startedAt - 1000);
  });

  it("AT-04: editing one note uploads exactly one file", async () => {
    const { world, drive, device } = setup();
    const a = device();
    a.files.put("a.md", "alpha");
    a.files.put("b.md", "beta");
    await a.sync();
    world.advance(MINUTE);
    a.files.put("a.md", "alpha 2");

    const report = await a.sync();

    expect(report).toMatchObject({ status: "done", uploaded: 1, downloaded: 0 });
    expect(drive.snapshot(VAULT)["a.md"]).toBe("alpha 2");
  });

  it("AT-05: an edit synced on B is downloaded on A, and only that file", async () => {
    const { world, a, b } = await twoSyncedDevices({ "n.md": "v1", "other.md": "x" });
    b.files.put("n.md", "v2 from B");
    expect(await b.sync()).toMatchObject({ uploaded: 1 });
    world.advance(MINUTE);

    const report = await a.sync();

    expect(report).toMatchObject({ status: "done", uploaded: 0, downloaded: 1, conflicts: 0 });
    expect(a.files.text("n.md")).toBe("v2 from B");
  });

  it("AT-06: an offline edit synced later still reaches the other device (no back-dating)", async () => {
    const { world, a, b } = await twoSyncedDevices({ "n.md": "v1", "m.md": "m1" });
    b.files.put("n.md", "edited offline on Monday"); // Monday
    world.advance(DAY);
    a.files.put("m.md", "m2");
    await a.sync(); // Tuesday
    world.advance(DAY);
    await b.sync(); // Wednesday
    world.advance(DAY);

    await a.sync(); // Thursday

    expect(a.files.text("n.md")).toBe("edited offline on Monday");
    expect(b.files.text("m.md")).toBe("m2");
  });

  it("AT-07: new nested folders are created once, even with parallel uploads", async () => {
    const { world, drive, device } = setup();
    const a = device();
    a.files.put("top.md", "t");
    await a.sync();
    world.advance(MINUTE);
    for (const name of ["c", "d", "e", "f", "g"]) a.files.put(`a/b/${name}.md`, name);

    const report = await a.sync();

    expect(report).toMatchObject({ status: "done", uploaded: 5 });
    expect(drive.countFolders(VAULT, "a")).toBe(1);
    expect(drive.countFolders(`${VAULT}/a`, "b")).toBe(1);
    expect(Object.keys(drive.snapshot(VAULT)).sort()).toEqual([
      "a/b/c.md",
      "a/b/d.md",
      "a/b/e.md",
      "a/b/f.md",
      "a/b/g.md",
      "top.md",
    ]);
  });

  it("AT-08: the same note edited on both devices keeps both versions everywhere", async () => {
    const { world, drive, a, b } = await twoSyncedDevices();
    a.files.put("n.md", "A version");
    b.files.put("n.md", "B version");
    await b.sync();
    world.advance(MINUTE);

    const report = await a.sync();

    expect(report).toMatchObject({ status: "done", conflicts: 1 });
    expect(a.files.text("n.md")).toBe("A version");
    const [copy] = conflictCopies(a);
    expect(copy).toBeDefined();
    expect(a.files.text(copy as string)).toBe("B version");

    // The copy is uploaded on A's next sync and reaches B.
    world.advance(MINUTE);
    await a.sync();
    world.advance(MINUTE);
    await b.sync();
    expect(b.files.text("n.md")).toBe("A version");
    expect(b.files.text(copy as string)).toBe("B version");
    expect(drive.snapshot(VAULT)).toEqual({ "n.md": "A version", [copy as string]: "B version" });

    // Stable afterwards: no further transfers or conflicts.
    world.advance(MINUTE);
    expect(await a.sync()).toMatchObject({ uploaded: 0, downloaded: 0, conflicts: 0 });
    expect(await b.sync()).toMatchObject({ uploaded: 0, downloaded: 0, conflicts: 0 });
  });

  it("AT-09: a network drop mid-sync leaves Last successful sync unchanged; re-running finishes cleanly", async () => {
    const { world, drive, device } = setup();
    const a = device();
    a.files.put("seed.md", "s");
    await a.sync();
    world.advance(MINUTE);
    const before = a.lastSyncTime;
    for (let i = 0; i < 12; i++) a.files.put(`n${i}.md`, `note ${i}`);

    let uploads = 0;
    drive.interceptor = (request) => {
      if (request.url.includes("/upload/") && ++uploads > 4) throw new NetworkError();
      return undefined;
    };
    const failed = await a.sync();

    expect(failed.status).toBe("incomplete");
    expect(failed.failed.length).toBeGreaterThan(0);
    expect(a.lastSyncTime).toBe(before);

    drive.interceptor = undefined;
    world.advance(MINUTE);
    const retried = await a.sync();

    expect(retried).toMatchObject({ status: "done", conflicts: 0, failed: [] });
    expect(a.lastSyncTime).not.toBe(before);
    expect(drive.snapshot(VAULT)).toEqual(a.files.snapshot()); // throws on duplicates
    expect(conflictCopies(a)).toEqual([]);
  });

  it("AT-09: responses lost after Drive applied the request create no duplicates", async () => {
    const { world, drive, device } = setup();
    const a = device();
    for (let i = 0; i < 6; i++) a.files.put(`f/n${i}.md`, `note ${i}`);
    let dropped = 0;
    drive.dropResponse = (request) =>
      request.method !== "GET" && request.url.includes("googleapis.com/") && dropped++ % 2 === 0;

    const report = await a.sync();
    drive.dropResponse = undefined;
    world.advance(MINUTE);
    await a.sync();

    expect(report.status).toBe("done");
    expect(drive.countFolders(VAULT, "f")).toBe(1);
    expect(drive.snapshot(VAULT)).toEqual(a.files.snapshot());
    expect(conflictCopies(a)).toEqual([]);
  });

  it("AT-10: an edit made while the file is being uploaded is kept and uploaded next sync", async () => {
    const { world, drive, a } = await twoSyncedDevices();
    a.files.put("n.md", "v2");
    let edited = false;
    a.files.onRead = (path) => {
      if (path === "n.md" && !edited) {
        edited = true;
        a.files.put("n.md", "v3 typed during sync");
      }
    };

    await a.sync();
    a.files.onRead = undefined;
    world.advance(MINUTE);
    await a.sync();

    expect(a.files.text("n.md")).toBe("v3 typed during sync");
    expect(drive.snapshot(VAULT)["n.md"]).toBe("v3 typed during sync");
  });

  it("AT-10: an edit made just before its download becomes a conflict, not an overwrite", async () => {
    const { world, drive, a, b } = await twoSyncedDevices();
    b.files.put("n.md", "B version");
    await b.sync();
    world.advance(MINUTE);
    const remoteId = a.store.data.state.fileIndex["n.md"]?.remoteId as string;
    drive.interceptor = (request) => {
      if (request.url.includes(`${remoteId}?alt=media`))
        a.files.put("n.md", "typed on A during sync");
      return undefined;
    };

    const report = await a.sync();
    drive.interceptor = undefined;

    expect(report.conflicts).toBe(1);
    expect(a.files.text("n.md")).toBe("typed on A during sync");
    const [copy] = conflictCopies(a);
    expect(a.files.text(copy as string)).toBe("B version");
    world.advance(MINUTE);
    await a.sync();
    expect(drive.snapshot(VAULT)).toMatchObject({
      "n.md": "typed on A during sync",
      [copy as string]: "B version",
    });
  });

  it("AT-11: wrong and changing device clocks don't affect correctness", async () => {
    const { world, drive, device } = setup();
    const a = device({ clockOffsetMs: -10 * MINUTE });
    const b = device({ clockOffsetMs: +10 * MINUTE });
    a.files.put("n.md", "v1");
    a.files.put("m.md", "m1");
    await a.sync();
    await b.sync();

    // AT-04 + AT-05 with skewed clocks.
    world.advance(MINUTE);
    b.files.put("n.md", "v2 from B");
    await b.sync();
    expect(await a.sync()).toMatchObject({ downloaded: 1, conflicts: 0 });
    expect(a.files.text("n.md")).toBe("v2 from B");

    // Clocks corrected (A jumps forward, B jumps back) between runs; AT-06 flow.
    a.clock.offsetMs = 0;
    b.clock.offsetMs = -2 * DAY;
    b.files.put("n.md", "v3 offline on B");
    world.advance(DAY);
    a.files.put("m.md", "m2 on A");
    await a.sync();
    world.advance(DAY);
    expect(await b.sync()).toMatchObject({ uploaded: 1, downloaded: 1, conflicts: 0 });
    world.advance(DAY);
    expect(await a.sync()).toMatchObject({ downloaded: 1, conflicts: 0 });

    expect(a.files.snapshot()).toEqual({ "n.md": "v3 offline on B", "m.md": "m2 on A" });
    expect(b.files.snapshot()).toEqual(a.files.snapshot());
    expect(drive.snapshot(VAULT)).toEqual(a.files.snapshot());
  });

  it("AT-12: repeated remote edits are downloaded without uploads or false conflicts", async () => {
    const { world, a, b } = await twoSyncedDevices();
    for (const version of ["v2", "v3", "v4"]) {
      b.files.put("n.md", version);
      await b.sync();
      world.advance(MINUTE);
      expect(await a.sync()).toMatchObject({ uploaded: 0, downloaded: 1, conflicts: 0 });
      expect(a.files.text("n.md")).toBe(version);
      world.advance(MINUTE);
    }
  });

  it("AT-13: a revoked refresh token stops the run before anything changes", async () => {
    const { world, drive, a } = await twoSyncedDevices();
    const before = a.lastSyncTime;
    const remoteBefore = drive.snapshot(VAULT);
    a.files.put("n.md", "local edit");
    drive.revokeRefreshToken();
    world.advance(MINUTE);

    const report = await a.sync();

    expect(report.status).toBe("aborted");
    expect(report.message).toBe(
      "Refresh token is invalid or revoked. Create a new one and update settings.",
    );
    expect(a.lastSyncTime).toBe(before);
    expect(drive.snapshot(VAULT)).toEqual(remoteBefore);
    expect(a.files.text("n.md")).toBe("local edit");
  });

  it("AT-14: pressing Sync during a run is refused", async () => {
    const { device } = setup();
    const a = device();
    a.files.put("a.md", "alpha");

    const [first, second] = await Promise.all([a.sync(), a.sync()]);

    expect(first.status).toBe("done");
    expect(second.status).toBe("already-running");
  });

  it("AT-15: a trashed vault folder is recreated and the whole vault re-uploaded", async () => {
    const { world, drive, device } = setup();
    const a = device();
    a.files.put("a.md", "alpha");
    a.files.put("notes/b.md", "beta");
    await a.sync();
    drive.trash(VAULT);
    world.advance(MINUTE);

    const report = await a.sync();

    expect(report).toMatchObject({ status: "done", uploaded: 2 });
    expect(drive.countFolders("obsidian", "Vault")).toBe(1);
    expect(drive.snapshot(VAULT)).toEqual({ "a.md": "alpha", "notes/b.md": "beta" });
  });

  it("AT-16: Google-native files and invalid names are skipped and logged; the run is done", async () => {
    const { world, drive, device } = setup();
    const a = device();
    a.files.put("a.md", "alpha");
    await a.sync();
    world.advance(MINUTE);
    drive.putFile(`${VAULT}/Doc`, "", "application/vnd.google-apps.document");
    drive.putFile(`${VAULT}/a:b.md`, "x");

    const report = await a.sync();

    expect(report).toMatchObject({ status: "done", skipped: 2, downloaded: 0, failed: [] });
    expect(a.log.lines).toContain("SKIP Doc Google-native file");
    expect(a.log.lines).toContain("SKIP a:b.md name not allowed in Obsidian");
    expect(a.files.paths()).toEqual(["a.md"]);
  });
});

describe("robustness", () => {
  it("never uploads excluded paths such as the config folder", async () => {
    const { drive, device } = setup();
    const a = device();
    a.files.put(".obsidian/plugins/drive-sync/data.json", "{secret}");
    a.files.put("notes/.DS_Store", "junk");
    a.files.put("a.md", "alpha");

    await a.sync();

    expect(drive.snapshot(VAULT)).toEqual({ "a.md": "alpha" });
  });

  it("downloads files added to nested new folders through the Drive web UI", async () => {
    const { world, drive, device } = setup();
    const a = device();
    a.files.put("a.md", "alpha");
    await a.sync();
    world.advance(MINUTE);
    drive.putFile(`${VAULT}/new/deep/x.md`, "from the web");
    drive.putFile("elsewhere/unrelated.md", "not in the vault");

    const report = await a.sync();

    expect(report).toMatchObject({ status: "done", downloaded: 1 });
    expect(a.files.text("new/deep/x.md")).toBe("from the web");
    expect(a.files.paths()).toEqual(["a.md", "new/deep/x.md"]);
  });

  it("catches up with changes hidden by Drive search lag through the query overlap", async () => {
    const { world, drive, a, b } = await twoSyncedDevices();
    drive.searchLagMs = 2 * MINUTE;
    b.files.put("n.md", "v2");
    await b.sync();
    world.advance(5_000); // well past second-precision rounding, still inside the lag

    await a.sync(); // B's change is not yet visible to search
    expect(a.files.text("n.md")).toBe("v1");
    world.advance(3 * MINUTE);
    await a.sync();

    expect(a.files.text("n.md")).toBe("v2");
  });

  it("never overwrites a local edit when uploading its conflict resolution fails", async () => {
    const { world, drive, a, b } = await twoSyncedDevices();
    a.files.put("n.md", "A version");
    b.files.put("n.md", "B version");
    await b.sync();
    world.advance(MINUTE);
    drive.interceptor = (request) => {
      if (request.method === "PATCH" || request.method === "PUT") throw new NetworkError();
      return undefined;
    };

    const failed = await a.sync();

    expect(failed.status).toBe("incomplete");
    expect(a.files.text("n.md")).toBe("A version");

    drive.interceptor = undefined;
    world.advance(MINUTE);
    const retried = await a.sync();
    expect(retried).toMatchObject({ status: "done", failed: [] });
    expect(a.files.text("n.md")).toBe("A version");
    expect(conflictCopies(a).map((p) => a.files.text(p))).toEqual(["B version"]);
  });

  it("downloads a remote change to a file that was re-saved locally without changes", async () => {
    const { world, a, b } = await twoSyncedDevices();
    a.files.put("n.md", "v1"); // same content, newer mtime
    b.files.put("n.md", "v2");
    await b.sync();
    world.advance(MINUTE);

    const report = await a.sync();

    expect(report).toMatchObject({ downloaded: 1, uploaded: 0, conflicts: 0 });
    expect(a.files.text("n.md")).toBe("v2");
  });

  it("retries rate limits and expired access tokens transparently", async () => {
    const { world, drive, a } = await twoSyncedDevices();
    let limited = 0;
    drive.interceptor = (request) => {
      if (request.url.includes("/upload/") && limited++ < 2) {
        return {
          status: 429,
          headers: { date: new Date(world.now).toUTCString(), "retry-after": "1" },
          body: new TextEncoder().encode("{}").buffer,
        };
      }
      return undefined;
    };
    drive.expireAccessTokens();
    a.files.put("n.md", "v2");

    const report = await a.sync();

    expect(report).toMatchObject({ status: "done", uploaded: 1 });
    expect(drive.snapshot(VAULT)["n.md"]).toBe("v2");
  });

  it("uses resumable uploads for large files", async () => {
    const { world, drive, device } = setup();
    const a = device();
    const big = "x".repeat(6 * 1024 * 1024);
    a.files.put("big.bin", big);
    await a.sync();
    world.advance(MINUTE);
    a.files.put("big.bin", `${big}y`);
    await a.sync();

    expect(drive.requests.some((r) => r.url.includes("uploadType=resumable"))).toBe(true);
    expect(drive.snapshot(VAULT)["big.bin"]).toBe(`${big}y`);
  });

  it("re-creates a file that was deleted in Drive when it is edited locally", async () => {
    const { world, drive, a } = await twoSyncedDevices();
    drive.trash(`${VAULT}/n.md`);
    world.advance(MINUTE);
    a.files.put("n.md", "v2");

    await a.sync();

    expect(drive.snapshot(VAULT)).toEqual({ "n.md": "v2" });
  });

  it("uses the remote folder name setting when set", async () => {
    const { drive, device } = setup();
    const a = device();
    a.store.data.settings.remoteFolderName = "Shared notes";
    a.files.put("a.md", "alpha");

    await a.sync();

    expect(drive.snapshot("obsidian/Shared notes")).toEqual({ "a.md": "alpha" });
  });

  it("first sync of a second device with diverged files keeps both versions", async () => {
    const { world, device } = setup();
    const a = device();
    a.files.put("same.md", "same");
    a.files.put("n.md", "A");
    await a.sync();
    world.advance(MINUTE);
    const b = device();
    b.files.put("same.md", "same");
    b.files.put("n.md", "B");

    const report = await b.sync();

    expect(report).toMatchObject({ status: "done", conflicts: 1, uploaded: 0 });
    expect(b.files.text("n.md")).toBe("B");
    expect(conflictCopies(b).map((p) => b.files.text(p))).toEqual(["A"]);
  });

  it("checkpoints the index during long runs", async () => {
    const { device } = setup();
    const a = device();
    for (let i = 0; i < 250; i++) a.files.put(`n${i}.md`, `note ${i}`);

    await a.sync();

    // Two checkpoints (100, 200) plus the final save.
    expect(a.store.saves).toBe(3);
    expect(Object.keys(a.store.data.state.fileIndex)).toHaveLength(250);
  });
});

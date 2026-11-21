import { describe, expect, it } from "vitest";
import { emptyReport } from "../../src/app/sync-report";
import { formatProgress, formatReport } from "../../src/ui/report-text";

describe("UI text (PRD §8)", () => {
  it("formats progress", () => {
    expect(
      formatProgress({ uploadDone: 3, uploadTotal: 10, downloadDone: 1, downloadTotal: 4 }),
    ).toBe("Syncing… ↑3/10 ↓1/4");
  });

  it("formats each outcome", () => {
    const done = { ...emptyReport(), uploaded: 4, downloaded: 2, conflicts: 1 };
    expect(formatReport(done)).toBe("Sync done — ↑4 ↓2 ⚠1 conflict");
    expect(formatReport({ ...emptyReport(), uploaded: 1 })).toBe("Sync done — ↑1 ↓0");
    expect(formatReport({ ...emptyReport(), status: "incomplete", failed: ["a", "b"] })).toBe(
      "Sync incomplete — 2 files failed. Run Sync again.",
    );
    expect(formatReport({ ...emptyReport(), status: "already-running" })).toBe(
      "Sync already running",
    );
    expect(formatReport({ ...emptyReport(), status: "aborted", message: "Bad token" })).toBe(
      "Bad token",
    );
  });
});

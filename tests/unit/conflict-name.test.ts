import { describe, expect, it } from "vitest";
import { conflictCopyPath } from "../../src/domain/conflict-name";

// TZ is pinned to UTC in vitest.config.ts.
const time = Date.parse("2026-11-21T10:15:42Z");

describe("conflictCopyPath (PRD FR-8)", () => {
  it("inserts the label before the extension", () => {
    expect(conflictCopyPath("notes/a.md", time)).toBe("notes/a (conflict 2026-11-21 1015).md");
  });

  it("handles files at the vault root and without an extension", () => {
    expect(conflictCopyPath("README", time)).toBe("README (conflict 2026-11-21 1015)");
  });

  it("only treats the last dot as the extension", () => {
    expect(conflictCopyPath("a.b/c.tar.gz", time)).toBe("a.b/c.tar (conflict 2026-11-21 1015).gz");
  });

  it("adds a counter for later attempts", () => {
    expect(conflictCopyPath("a.md", time, 2)).toBe("a (conflict 2026-11-21 1015 2).md");
  });

  it("depends only on the remote time, so retries produce the same name", () => {
    expect(conflictCopyPath("a.md", time)).toBe(conflictCopyPath("a.md", time));
  });
});

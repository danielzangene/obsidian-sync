import { describe, expect, it } from "vitest";
import { basename, dirname, joinPath, pathSegments } from "../../src/domain/paths";

describe("paths", () => {
  it("splits and joins vault-relative paths", () => {
    expect(dirname("a/b/c.md")).toBe("a/b");
    expect(dirname("c.md")).toBe("");
    expect(basename("a/b/c.md")).toBe("c.md");
    expect(joinPath("", "c.md")).toBe("c.md");
    expect(joinPath("a/b", "c.md")).toBe("a/b/c.md");
    expect(pathSegments("")).toEqual([]);
    expect(pathSegments("a/b")).toEqual(["a", "b"]);
  });
});

import { describe, expect, it } from "vitest";
import { isExcludedPath, isValidName } from "../../src/domain/exclusions";

describe("isExcludedPath (PRD FR-5)", () => {
  it.each([
    ".obsidian/plugins/gdrive-sync/data.json",
    ".config-renamed/app.json",
    ".trash/old.md",
    ".git/HEAD",
    "notes/.DS_Store",
    "images/Thumbs.db",
    "a/.hidden/b.md",
  ])("excludes %s", (path) => expect(isExcludedPath(path)).toBe(true));

  it.each(["notes/a.md", "a.b/c.md", "Thumbs.db.md", "notes/file."])("includes %s", (path) =>
    expect(isExcludedPath(path)).toBe(false),
  );
});

describe("isValidName", () => {
  it.each(["a.md", "Meeting notes 2026.md", "über.md"])("accepts %s", (name) =>
    expect(isValidName(name)).toBe(true),
  );
  it.each(["a:b.md", "a*b", 'a"b', "a\\b", "a/b", "a<b", "a>b", "a|b", "a?b", "", " ", ".", ".."])(
    "rejects %j",
    (name) => expect(isValidName(name)).toBe(false),
  );
});

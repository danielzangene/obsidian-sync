import { describe, expect, it } from "vitest";
import { decide } from "../../src/domain/decide";

describe("decide (DESIGN §5.3)", () => {
  // Every combination of presence/equality for local (L), remote (R) and base (B).
  const cases: [string, string | undefined, string | undefined, string | undefined, string][] = [
    ["D1 local only, no base", "a", undefined, undefined, "upload"],
    ["D1 local only, with base", "a", undefined, "b", "upload"],
    ["D2 remote only, no base", undefined, "a", undefined, "download"],
    ["D2 remote only, with base", undefined, "a", "b", "download"],
    ["D3 equal, no base", "a", "a", undefined, "none"],
    ["D3 equal, base equal", "a", "a", "a", "none"],
    ["D3 equal, base differs", "a", "a", "b", "none"],
    ["D4 only remote changed", "a", "b", "a", "download"],
    ["D5 only local changed", "a", "b", "b", "upload"],
    ["D6 both changed", "a", "b", "c", "conflict"],
    ["D6 no base, contents differ", "a", "b", undefined, "conflict"],
    ["neither side", undefined, undefined, "a", "none"],
  ];

  it.each(cases)("%s", (_name, local, remote, base, expected) => {
    expect(decide(local, remote, base)).toBe(expected);
  });
});

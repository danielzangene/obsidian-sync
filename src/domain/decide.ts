import type { Md5, SyncAction } from "./types";

/**
 * Three-way decision rule (DESIGN §5.3). The first matching row wins.
 *
 * | # | Condition         | Action   |
 * |---|-------------------|----------|
 * | 1 | local only        | upload   |
 * | 2 | remote only       | download |
 * | 3 | local = remote    | none     |
 * | 4 | local = base      | download |
 * | 5 | remote = base     | upload   |
 * | 6 | otherwise         | conflict |
 */
export function decide(local?: Md5, remote?: Md5, base?: Md5): SyncAction {
  if (local === undefined && remote === undefined) return "none";
  if (remote === undefined) return "upload";
  if (local === undefined) return "download";
  if (local === remote) return "none";
  if (local === base) return "download";
  if (remote === base) return "upload";
  return "conflict";
}

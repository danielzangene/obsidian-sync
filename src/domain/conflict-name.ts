import { basename, dirname, joinPath } from "./paths";

const pad = (n: number) => String(n).padStart(2, "0");

/** `YYYY-MM-DD HHmm` in the device's local time zone. */
export function formatConflictStamp(timeMs: number): string {
  const d = new Date(timeMs);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}${pad(d.getMinutes())}`;
}

/**
 * Name of the conflict copy for `path` (PRD FR-8, DESIGN §5.6):
 * `notes/a.md` → `notes/a (conflict 2026-11-21 1015).md`. `attempt` ≥ 2 adds a counter
 * for when a different file already has the name.
 */
export function conflictCopyPath(path: string, remoteModifiedTimeMs: number, attempt = 1): string {
  const name = basename(path);
  const dot = name.lastIndexOf(".");
  const hasExtension = dot > 0;
  const stem = hasExtension ? name.slice(0, dot) : name;
  const extension = hasExtension ? name.slice(dot) : "";
  const counter = attempt > 1 ? ` ${attempt}` : "";
  const label = `conflict ${formatConflictStamp(remoteModifiedTimeMs)}${counter}`;
  return joinPath(dirname(path), `${stem} (${label})${extension}`);
}

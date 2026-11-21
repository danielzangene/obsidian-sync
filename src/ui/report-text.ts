import type { SyncProgress, SyncReport } from "../app/sync-report";

/** Status bar / progress text (PRD §8). */
export function formatProgress(progress: SyncProgress): string {
  return (
    `Syncing… ↑${progress.uploadDone}/${progress.uploadTotal} ` +
    `↓${progress.downloadDone}/${progress.downloadTotal}`
  );
}

/** Summary notice text (PRD §8). */
export function formatReport(report: SyncReport): string {
  switch (report.status) {
    case "already-running":
      return "Sync already running";
    case "aborted":
      return report.message ?? "Sync failed";
    case "incomplete": {
      const count = report.failed.length;
      return `Sync incomplete — ${count} ${count === 1 ? "file" : "files"} failed. Run Sync again.`;
    }
    case "done": {
      const conflicts =
        report.conflicts > 0
          ? ` ⚠${report.conflicts} ${report.conflicts === 1 ? "conflict" : "conflicts"}`
          : "";
      return `Sync done — ↑${report.uploaded} ↓${report.downloaded}${conflicts}`;
    }
  }
}

/** "Last successful sync" setting value. */
export function formatLastSync(lastSyncTime: string, epochIso: string): string {
  return lastSyncTime === epochIso ? "Never" : new Date(lastSyncTime).toLocaleString();
}

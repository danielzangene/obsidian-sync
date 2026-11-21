export type SyncStatus = "done" | "incomplete" | "aborted" | "already-running";

/** Outcome of one run, rendered by the UI (PRD §8). */
export interface SyncReport {
  status: SyncStatus;
  uploaded: number;
  downloaded: number;
  conflicts: number;
  skipped: number;
  /** Paths that still failed after retries. */
  failed: string[];
  warnings: string[];
  /** Why the run was aborted; safe to show to the user. */
  message?: string;
}

export interface SyncProgress {
  uploadDone: number;
  uploadTotal: number;
  downloadDone: number;
  downloadTotal: number;
}

export function emptyReport(): SyncReport {
  return {
    status: "done",
    uploaded: 0,
    downloaded: 0,
    conflicts: 0,
    skipped: 0,
    failed: [],
    warnings: [],
  };
}

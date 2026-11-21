import { SyncAbortError } from "../domain/errors";
import type { FileIndex, IndexEntry, LocalFileInfo, Md5, RemoteFile } from "../domain/types";
import type { LocalFiles } from "../ports/local-files";
import type { RemoteFiles } from "../ports/remote-files";
import type { SyncLog } from "../ports/sync-log";
import type { SyncProgress, SyncReport } from "./sync-report";

/** Everything one run's passes share. */
export interface RunContext {
  local: LocalFiles;
  remote: RemoteFiles;
  log: SyncLog;
  /** Live reference into persisted state. */
  index: FileIndex;
  /** Remote change set, keyed by path. */
  remoteChanges: Map<string, RemoteFile>;
  /** Paths decided (or failed) in the upload pass; the download pass skips them. */
  handled: Set<string>;
  report: SyncReport;
  progress: SyncProgress;
  emitProgress(): void;
  /** Call after every transfer; checkpoints the index periodically (DESIGN §4.2). */
  afterTransfer(): Promise<void>;
}

/** A local file's bytes, hash and the stat taken before reading them. */
export interface LocalSnapshot {
  data: ArrayBuffer;
  md5: Md5;
  info: LocalFileInfo;
}

export function indexEntry(remoteId: string, md5: Md5, info: LocalFileInfo): IndexEntry {
  return { remoteId, md5, mtimeMs: info.mtimeMs, size: info.size };
}

export function isTouched(file: LocalFileInfo, entry: IndexEntry | undefined): boolean {
  return entry === undefined || entry.mtimeMs !== file.mtimeMs || entry.size !== file.size;
}

/** Message for logs: status/reason or error text, truncated. Never request bodies or tokens. */
export function describeError(error: unknown): string {
  const text = error instanceof Error ? error.message : "unexpected error";
  return text.length > 200 ? `${text.slice(0, 200)}…` : text;
}

/**
 * Records a per-file failure and lets the run continue. Errors that must stop the whole run
 * (e.g. a revoked token) are rethrown.
 */
export function recordFailure(ctx: RunContext, path: string, error: unknown): void {
  if (error instanceof SyncAbortError) throw error;
  ctx.handled.add(path);
  ctx.report.failed.push(path);
  ctx.log.record("ERROR", path, describeError(error));
}

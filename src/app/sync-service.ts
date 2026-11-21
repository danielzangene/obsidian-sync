import {
  EPOCH_ISO,
  EPOCH_MS,
  INDEX_CHECKPOINT_INTERVAL,
  REMOTE_QUERY_OVERLAP_MS,
} from "../domain/constants";
import { SyncAbortError } from "../domain/errors";
import type { LocalFiles } from "../ports/local-files";
import type { RemoteFiles, RemoteListing } from "../ports/remote-files";
import type { StateStore, SyncState } from "../ports/state-store";
import type { SyncLog } from "../ports/sync-log";
import { runDownloadPass } from "./download-pass";
import { describeError, type RunContext } from "./run-context";
import { emptyReport, type SyncProgress, type SyncReport } from "./sync-report";
import { runUploadPass } from "./upload-pass";

export interface SyncServiceDependencies {
  local: LocalFiles;
  remote: RemoteFiles;
  store: StateStore;
  log: SyncLog;
  onProgress?: (progress: SyncProgress) => void;
}

/** Runs the Sync command (DESIGN §5.1). One run at a time. */
export class SyncService {
  private running = false;

  constructor(private readonly deps: SyncServiceDependencies) {}

  get isRunning(): boolean {
    return this.running;
  }

  async run(): Promise<SyncReport> {
    if (this.running) return { ...emptyReport(), status: "already-running" };
    this.running = true;

    const { store, log } = this.deps;
    const report = emptyReport();
    log.record("RUN", "", "start");
    try {
      await this.execute(store.data.state, report);
    } catch (error) {
      report.status = "aborted";
      report.message =
        error instanceof SyncAbortError
          ? error.userMessage
          : `Sync failed: ${describeError(error)}`;
      log.record("ERROR", "", report.message);
    } finally {
      for (const warning of report.warnings) log.record("WARN", "", warning);
      log.record("RUN", "", summarize(report));
      await this.persist();
      this.running = false;
    }
    return report;
  }

  private async execute(state: SyncState, report: SyncReport): Promise<void> {
    const { remote } = this.deps;
    const connection = await remote.connect();
    report.warnings.push(...connection.warnings);
    if (connection.vaultFolderReplaced) {
      state.fileIndex = {};
      state.lastSyncTime = EPOCH_ISO;
    }

    const listing = await this.listRemoteChanges(state.lastSyncTime);
    report.warnings.push(...listing.warnings);
    for (const item of listing.skipped) {
      report.skipped++;
      this.deps.log.record("SKIP", item.path, item.reason);
    }

    const ctx = this.createContext(state, listing, report);
    await runUploadPass(ctx);
    await runDownloadPass(ctx);

    if (report.failed.length === 0) {
      // The only place the watermark moves (DESIGN §4.2).
      state.lastSyncTime = new Date(connection.syncStartTimeMs).toISOString();
      report.status = "done";
    } else {
      report.status = "incomplete";
    }
  }

  private listRemoteChanges(lastSyncTime: string): Promise<RemoteListing> {
    const lastSyncMs = Date.parse(lastSyncTime);
    if (Number.isNaN(lastSyncMs) || lastSyncMs <= EPOCH_MS) return this.deps.remote.listAll();
    return this.deps.remote.listChangedSince(lastSyncMs - REMOTE_QUERY_OVERLAP_MS);
  }

  private createContext(state: SyncState, listing: RemoteListing, report: SyncReport): RunContext {
    const { local, remote, log, onProgress } = this.deps;
    const progress: SyncProgress = {
      uploadDone: 0,
      uploadTotal: 0,
      downloadDone: 0,
      downloadTotal: 0,
    };
    let transfers = 0;
    return {
      local,
      remote,
      log,
      index: state.fileIndex,
      remoteChanges: listing.files,
      handled: new Set(),
      report,
      progress,
      emitProgress: () => onProgress?.({ ...progress }),
      afterTransfer: async () => {
        if (++transfers % INDEX_CHECKPOINT_INTERVAL === 0) await this.deps.store.save();
      },
    };
  }

  /** Saves the index and drive cache after every run, successful or not (DESIGN §4.2). */
  private async persist(): Promise<void> {
    try {
      await this.deps.store.save();
    } catch (error) {
      this.deps.log.record("ERROR", "", `Couldn't save sync state: ${describeError(error)}`);
    }
    try {
      await this.deps.log.flush();
    } catch {
      // The log is best-effort; a failed write must not fail the run.
    }
  }
}

function summarize(report: SyncReport): string {
  return (
    `${report.status} — uploaded ${report.uploaded}, downloaded ${report.downloaded}, ` +
    `conflicts ${report.conflicts}, skipped ${report.skipped}, failed ${report.failed.length}`
  );
}

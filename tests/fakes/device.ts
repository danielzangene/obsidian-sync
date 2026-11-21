import { GoogleDriveRemoteFiles } from "../../src/adapters/google/google-drive-remote-files";
import { SyncService } from "../../src/app/sync-service";
import type { SyncReport } from "../../src/app/sync-report";
import type { FakeDrive } from "./fake-drive";
import { MemoryLocalFiles } from "./memory-local-files";
import { MemoryStateStore } from "./memory-state-store";
import { MemorySyncLog } from "./memory-sync-log";
import { DeviceClock, type SimWorld } from "./sim-world";

export interface DeviceOptions {
  vaultName?: string;
  clockOffsetMs?: number;
}

/** One simulated Obsidian device: real sync service and Google adapter on in-memory fakes. */
export class Device {
  readonly clock: DeviceClock;
  readonly files: MemoryLocalFiles;
  readonly store = new MemoryStateStore();
  readonly log = new MemorySyncLog();
  readonly service: SyncService;
  /** The refresh token this device was configured with. */
  refreshToken: string;

  constructor(world: SimWorld, drive: FakeDrive, options: DeviceOptions = {}) {
    this.clock = new DeviceClock(world, options.clockOffsetMs ?? 0);
    this.files = new MemoryLocalFiles(this.clock);
    this.refreshToken = drive.refreshToken;
    const vaultName = options.vaultName ?? "Vault";

    const remote = new GoogleDriveRemoteFiles({
      transport: drive.transport,
      credentials: () => ({
        clientId: drive.clientId,
        clientSecret: drive.clientSecret,
        refreshToken: this.refreshToken,
      }),
      cache: () => this.store.data.state.driveCache,
      vaultFolderName: () => this.store.data.settings.remoteFolderName || vaultName,
      clock: this.clock,
      random: () => 0.5,
    });
    this.service = new SyncService({
      local: this.files,
      remote,
      store: this.store,
      log: this.log,
    });
  }

  sync(): Promise<SyncReport> {
    return this.service.run();
  }

  get lastSyncTime(): string {
    return this.store.data.state.lastSyncTime;
  }
}

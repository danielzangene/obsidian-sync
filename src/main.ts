import { Notice, Platform, Plugin, normalizePath } from "obsidian";
import { ObsidianLocalFiles } from "./adapters/obsidian/obsidian-local-files";
import { obsidianTransport } from "./adapters/obsidian/obsidian-transport";
import { FileSyncLog } from "./adapters/obsidian/file-sync-log";
import { PluginDataStateStore } from "./adapters/obsidian/plugin-data-state-store";
import { GoogleDriveRemoteFiles } from "./adapters/google/google-drive-remote-files";
import type { OAuthCredentials } from "./adapters/google/oauth-token-provider";
import { SystemClock } from "./adapters/system/system-clock";
import { SyncService } from "./app/sync-service";
import { ProgressIndicator } from "./ui/progress-indicator";
import { formatReport } from "./ui/report-text";
import { DriveSyncSettingTab } from "./ui/settings-tab";

/** Composition root (DESIGN §3.1): builds the adapters and wires them into the sync service. */
export default class DriveSyncPlugin extends Plugin {
  private store!: PluginDataStateStore;
  private service!: SyncService;
  private progress!: ProgressIndicator;

  override async onload(): Promise<void> {
    this.store = await PluginDataStateStore.load(this);
    const clock = new SystemClock();
    const vault = this.app.vault;

    const remote = new GoogleDriveRemoteFiles({
      transport: obsidianTransport,
      credentials: () => this.credentials(),
      cache: () => this.store.data.state.driveCache,
      vaultFolderName: () => this.store.data.settings.remoteFolderName || vault.getName(),
      clock,
    });

    this.progress = new ProgressIndicator(Platform.isMobile ? null : this.addStatusBarItem());
    this.service = new SyncService({
      local: new ObsidianLocalFiles(vault),
      remote,
      store: this.store,
      log: new FileSyncLog(
        vault.adapter,
        normalizePath(`${this.manifest.dir ?? ""}/sync.log`),
        clock,
      ),
      onProgress: (progress) => this.progress.update(progress),
    });

    this.addCommand({ id: "sync", name: "Sync", callback: () => void this.sync() });
    this.addRibbonIcon("refresh-cw", "Sync with Google Drive", () => void this.sync());
    this.addSettingTab(
      new DriveSyncSettingTab(this.app, this, {
        store: this.store,
        vaultName: () => vault.getName(),
      }),
    );
  }

  private async sync(): Promise<void> {
    const report = await this.service.run();
    this.progress.clear();
    for (const warning of report.warnings) new Notice(warning);
    new Notice(formatReport(report));
  }

  /** Resolves credentials; secrets come from Obsidian's secret storage. */
  private credentials(): OAuthCredentials | null {
    const { clientId, clientSecretName, refreshTokenName } = this.store.data.settings;
    const secrets = this.app.secretStorage;
    const clientSecret = clientSecretName === "" ? null : secrets.getSecret(clientSecretName);
    const refreshToken = refreshTokenName === "" ? null : secrets.getSecret(refreshTokenName);
    if (clientId === "" || !clientSecret || !refreshToken) return null;
    return { clientId, clientSecret, refreshToken };
  }
}

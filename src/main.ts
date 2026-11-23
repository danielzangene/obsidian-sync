import { Notice, Platform, Plugin, normalizePath } from "obsidian";
import { ObsidianLocalFiles } from "./adapters/obsidian/obsidian-local-files";
import { obsidianTransport } from "./adapters/obsidian/obsidian-transport";
import { FileSyncLog } from "./adapters/obsidian/file-sync-log";
import { migrateLegacySecrets } from "./adapters/obsidian/persisted-data";
import { PluginDataStateStore } from "./adapters/obsidian/plugin-data-state-store";
import { SecretStorageCredentialStore } from "./adapters/obsidian/secret-storage-credential-store";
import { GoogleDriveRemoteFiles } from "./adapters/google/google-drive-remote-files";
import type { OAuthCredentials } from "./adapters/google/oauth-token-provider";
import { SystemClock } from "./adapters/system/system-clock";
import { SyncService } from "./app/sync-service";
import type { CredentialStore } from "./ports/credential-store";
import { ProgressIndicator } from "./ui/progress-indicator";
import { formatReport } from "./ui/report-text";
import { DriveSyncSettingTab } from "./ui/settings-tab";

/** Composition root (DESIGN §3.1): builds the adapters and wires them into the sync service. */
export default class DriveSyncPlugin extends Plugin {
  private store!: PluginDataStateStore;
  private credentialStore!: CredentialStore;
  private service!: SyncService;
  private progress!: ProgressIndicator;

  override async onload(): Promise<void> {
    const raw: unknown = await this.loadData();
    this.store = PluginDataStateStore.fromRaw(this, raw);
    this.credentialStore = new SecretStorageCredentialStore(this.app.secretStorage);
    migrateLegacySecrets(
      raw,
      (name) => this.app.secretStorage.getSecret(name),
      this.credentialStore,
    );
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
        credentials: this.credentialStore,
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

  /** Current credentials, or `null` if any is missing. */
  private credentials(): OAuthCredentials | null {
    const { clientId } = this.store.data.settings;
    const clientSecret = this.credentialStore.get("clientSecret");
    const refreshToken = this.credentialStore.get("refreshToken");
    if (clientId === "" || clientSecret === null || refreshToken === null) return null;
    return { clientId, clientSecret, refreshToken };
  }
}

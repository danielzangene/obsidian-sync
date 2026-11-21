import { PluginSettingTab, type App, type Plugin, type SettingDefinitionItem } from "obsidian";
import { EPOCH_ISO } from "../domain/constants";
import type { Settings, StateStore } from "../ports/state-store";
import { formatLastSync } from "./report-text";

export interface SettingsHost {
  store: StateStore;
  vaultName(): string;
}

const SETTING_KEYS: readonly (keyof Settings)[] = [
  "clientId",
  "clientSecretName",
  "refreshTokenName",
  "remoteFolderName",
];

const isSettingKey = (key: string): key is keyof Settings =>
  (SETTING_KEYS as readonly string[]).includes(key);

/**
 * Settings tab (PRD FR-1), using Obsidian's declarative settings API so the settings appear in
 * settings search. Secret controls store only the name of a secret in Obsidian's secret storage.
 */
export class DriveSyncSettingTab extends PluginSettingTab {
  constructor(
    app: App,
    plugin: Plugin,
    private readonly host: SettingsHost,
  ) {
    super(app, plugin);
  }

  override getSettingDefinitions(): SettingDefinitionItem[] {
    const vaultName = this.host.vaultName();
    return [
      {
        name: "Client ID",
        desc: "OAuth client ID from Google Cloud Console.",
        control: { type: "text", key: "clientId" },
      },
      {
        name: "Client secret",
        desc: "OAuth client secret, kept in Obsidian's secret storage.",
        control: { type: "secret", key: "clientSecretName" },
      },
      {
        name: "Refresh token",
        desc: "Kept in Obsidian's secret storage. It gives full access to your Google Drive, so don't share it.",
        control: { type: "secret", key: "refreshTokenName" },
      },
      {
        name: "Remote folder name",
        desc: `Folder inside "obsidian" in Google Drive. Leave empty to use the vault name ("${vaultName}").`,
        control: { type: "text", key: "remoteFolderName", placeholder: vaultName },
      },
      {
        name: "Last successful sync",
        render: (setting) => {
          setting.setDesc(formatLastSync(this.host.store.data.state.lastSyncTime, EPOCH_ISO));
        },
      },
    ];
  }

  override getControlValue(key: string): unknown {
    return isSettingKey(key) ? this.host.store.data.settings[key] : undefined;
  }

  override async setControlValue(key: string, value: unknown): Promise<void> {
    if (!isSettingKey(key)) return;
    const text = typeof value === "string" ? value : "";
    this.host.store.data.settings[key] =
      key === "clientId" || key === "remoteFolderName" ? text.trim() : text;
    await this.host.store.save();
  }
}

import {
  PluginSettingTab,
  type App,
  type Plugin,
  type Setting,
  type SettingDefinitionItem,
} from "obsidian";
import { EPOCH_ISO } from "../domain/constants";
import type { CredentialStore, SecretKey } from "../ports/credential-store";
import type { Settings, StateStore } from "../ports/state-store";
import { formatLastSync } from "./report-text";

export interface SettingsHost {
  store: StateStore;
  credentials: CredentialStore;
  vaultName(): string;
}

const SETTING_KEYS: readonly (keyof Settings)[] = ["clientId", "remoteFolderName"];

const isSettingKey = (key: string): key is keyof Settings =>
  (SETTING_KEYS as readonly string[]).includes(key);

const README_URL = "https://github.com/danielzangene/obsidian-sync#setup";

/**
 * Settings tab (PRD FR-1), on Obsidian's declarative settings API so the settings appear in
 * settings search. The client secret and refresh token are pasted into masked text fields and
 * written straight to the `CredentialStore`, never to the plugin's data file.
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
        desc: `OAuth client ID from Google Cloud Console. See the README for how to get it: ${README_URL}`,
        control: { type: "text", key: "clientId", placeholder: "…apps.googleusercontent.com" },
      },
      {
        name: "Client secret",
        desc: "Paste your OAuth client secret. Kept in Obsidian's secret storage.",
        render: (setting) => this.renderSecretField(setting, "clientSecret", "Paste client secret"),
      },
      {
        name: "Refresh token",
        desc: "Paste your refresh token. Kept in Obsidian's secret storage. It gives full access to your Google Drive, so don't share it.",
        render: (setting) => this.renderSecretField(setting, "refreshToken", "Paste refresh token"),
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
    this.host.store.data.settings[key] = typeof value === "string" ? value.trim() : "";
    await this.host.store.save();
  }

  /** A masked text field whose value goes to the credential store. */
  private renderSecretField(setting: Setting, key: SecretKey, placeholder: string): void {
    setting.addText((text) => {
      text.inputEl.type = "password";
      text.inputEl.autocomplete = "off";
      text
        .setPlaceholder(placeholder)
        .setValue(this.host.credentials.get(key) ?? "")
        // Pasted tokens often carry stray spaces or line breaks.
        .onChange((value) => this.host.credentials.set(key, value.trim()));
    });
  }
}

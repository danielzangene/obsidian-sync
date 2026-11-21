import type { Plugin } from "obsidian";
import type { PersistedData, StateStore } from "../../ports/state-store";
import { normalizePersistedData } from "./persisted-data";

/** Persists state in the plugin's `data.json`. Saves are serialized. */
export class PluginDataStateStore implements StateStore {
  private lastSave: Promise<void> = Promise.resolve();

  private constructor(
    private readonly plugin: Plugin,
    readonly data: PersistedData,
  ) {}

  static async load(plugin: Plugin): Promise<PluginDataStateStore> {
    return new PluginDataStateStore(plugin, normalizePersistedData(await plugin.loadData()));
  }

  save(): Promise<void> {
    this.lastSave = this.lastSave
      .catch(() => undefined)
      .then(() => this.plugin.saveData(this.data));
    return this.lastSave;
  }
}

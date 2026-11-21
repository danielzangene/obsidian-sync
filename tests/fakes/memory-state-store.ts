import { defaultPersistedData } from "../../src/adapters/obsidian/persisted-data";
import type { PersistedData, StateStore } from "../../src/ports/state-store";

export class MemoryStateStore implements StateStore {
  readonly data: PersistedData = defaultPersistedData();
  saves = 0;

  save(): Promise<void> {
    this.saves++;
    return Promise.resolve();
  }
}

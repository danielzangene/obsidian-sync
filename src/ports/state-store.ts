import type { FileIndex } from "../domain/types";

export const SCHEMA_VERSION = 1;

export interface Settings {
  clientId: string;
  /** Name of the client secret in Obsidian's secret storage (not the secret itself). */
  clientSecretName: string;
  /** Name of the refresh token in Obsidian's secret storage (not the token itself). */
  refreshTokenName: string;
  /** Remote folder inside `obsidian/`. Empty = vault name (PRD OQ-3). */
  remoteFolderName: string;
}

/** Drive IDs cached by the Google adapter (DESIGN §4.1). */
export interface DriveCache {
  vaultFolderId: string | null;
  /** Vault-relative folder path → Drive folder ID. */
  folderIds: Record<string, string>;
}

export interface SyncState {
  /** Server time at the start of the last fully successful run (ISO 8601). */
  lastSyncTime: string;
  fileIndex: FileIndex;
  driveCache: DriveCache;
}

export interface PersistedData {
  schemaVersion: number;
  settings: Settings;
  state: SyncState;
}

/** Owns the single in-memory copy of persisted data, shared by the UI and the sync run. */
export interface StateStore {
  readonly data: PersistedData;
  save(): Promise<void>;
}

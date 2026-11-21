import { EPOCH_ISO } from "../../domain/constants";
import type { FileIndex } from "../../domain/types";
import type { CredentialStore, SecretKey } from "../../ports/credential-store";
import { SCHEMA_VERSION, type PersistedData } from "../../ports/state-store";

export function defaultPersistedData(): PersistedData {
  return {
    schemaVersion: SCHEMA_VERSION,
    settings: { clientId: "", remoteFolderName: "" },
    state: {
      lastSyncTime: EPOCH_ISO,
      fileIndex: {},
      driveCache: { vaultFolderId: null, folderIds: {} },
    },
  };
}

type UnknownRecord = Record<string, unknown>;

const isRecord = (value: unknown): value is UnknownRecord =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const asString = (value: unknown, fallback = ""): string =>
  typeof value === "string" ? value : fallback;

const asStringRecord = (value: unknown): Record<string, string> =>
  isRecord(value)
    ? Object.fromEntries(
        Object.entries(value).filter(
          (entry): entry is [string, string] => typeof entry[1] === "string",
        ),
      )
    : {};

function asFileIndex(value: unknown): FileIndex {
  if (!isRecord(value)) return {};
  const index: FileIndex = {};
  for (const [path, entry] of Object.entries(value)) {
    if (
      isRecord(entry) &&
      typeof entry.remoteId === "string" &&
      typeof entry.md5 === "string" &&
      typeof entry.mtimeMs === "number" &&
      typeof entry.size === "number"
    ) {
      index[path] = {
        remoteId: entry.remoteId,
        md5: entry.md5,
        mtimeMs: entry.mtimeMs,
        size: entry.size,
      };
    }
  }
  return index;
}

function asIsoTime(value: unknown): string {
  return typeof value === "string" && !Number.isNaN(Date.parse(value)) ? value : EPOCH_ISO;
}

/**
 * Turns whatever `loadData()` returned into valid `PersistedData`. Missing or malformed fields
 * fall back to defaults, so damaged state leads to a full (safe) sync, never an error
 * (DESIGN §4.1). Future schema migrations go here, keyed on `schemaVersion`.
 */
export function normalizePersistedData(raw: unknown): PersistedData {
  const data = defaultPersistedData();
  if (!isRecord(raw)) return data;

  const settings = isRecord(raw.settings) ? raw.settings : {};
  data.settings = {
    clientId: asString(settings.clientId),
    remoteFolderName: asString(settings.remoteFolderName),
  };

  const state = isRecord(raw.state) ? raw.state : {};
  const driveCache = isRecord(state.driveCache) ? state.driveCache : {};
  data.state = {
    lastSyncTime: asIsoTime(state.lastSyncTime),
    fileIndex: asFileIndex(state.fileIndex),
    driveCache: {
      vaultFolderId: typeof driveCache.vaultFolderId === "string" ? driveCache.vaultFolderId : null,
      folderIds: asStringRecord(driveCache.folderIds),
    },
  };
  return data;
}

/**
 * Schema v1 (0.1.0) stored the *names* of user-chosen entries in Obsidian's secret storage.
 * Schema v2 stores the values under fixed IDs. Copies the old values over once, without
 * overwriting anything already set.
 */
export function migrateLegacySecrets(
  raw: unknown,
  readNamedSecret: (name: string) => string | null,
  store: CredentialStore,
): void {
  const settings = isRecord(raw) && isRecord(raw.settings) ? raw.settings : {};
  const legacyNames: [SecretKey, unknown][] = [
    ["clientSecret", settings.clientSecretName],
    ["refreshToken", settings.refreshTokenName],
  ];
  for (const [key, name] of legacyNames) {
    if (typeof name !== "string" || name === "" || store.get(key) !== null) continue;
    const value = readNamedSecret(name);
    if (value !== null && value !== "") store.set(key, value);
  }
}

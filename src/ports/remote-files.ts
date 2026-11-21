import type { RemoteFile } from "../domain/types";

export interface ConnectResult {
  /** Server time at the start of this run, epoch ms (DESIGN §4.2). */
  syncStartTimeMs: number;
  /** The remote vault folder differs from the cached one; the caller must reset its index. */
  vaultFolderReplaced: boolean;
  /** User-facing warnings, e.g. duplicate folders. */
  warnings: string[];
}

export interface SkippedItem {
  path: string;
  reason: string;
}

export interface RemoteListing {
  /** Remote files keyed by vault-relative path. */
  files: Map<string, RemoteFile>;
  skipped: SkippedItem[];
  /** User-facing warnings, e.g. duplicate files at one path. */
  warnings: string[];
}

/**
 * Path-based view of the remote vault folder (DESIGN §3.2). Implementations keep any
 * ID/parent mapping to themselves.
 */
export interface RemoteFiles {
  /** Authenticates, captures the server time and resolves the vault folder. */
  connect(): Promise<ConnectResult>;
  /** Every file in the vault folder. */
  listAll(): Promise<RemoteListing>;
  /** Files modified after `sinceMs` (server time). */
  listChangedSince(sinceMs: number): Promise<RemoteListing>;
  /** The file at `path`, or `null`. */
  find(path: string): Promise<RemoteFile | null>;
  /** Uploads `data` to `path`: updates `remoteId` if given and still valid, otherwise creates. */
  upload(path: string, data: ArrayBuffer, remoteId?: string): Promise<RemoteFile>;
  download(remoteId: string): Promise<ArrayBuffer>;
}

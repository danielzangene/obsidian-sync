/** Hex-encoded MD5 of a file's bytes. */
export type Md5 = string;

/** A local file's identity for change detection. */
export interface LocalFileInfo {
  /** Vault-relative path, `/`-separated. */
  path: string;
  mtimeMs: number;
  size: number;
}

/** A remote file as seen by the app layer. */
export interface RemoteFile {
  path: string;
  /** Opaque remote identifier. */
  remoteId: string;
  md5: Md5;
  /** Server-side modification time, epoch ms. */
  modifiedTimeMs: number;
  size: number;
}

/** One sync index entry: a file as it was when this device last synced it. */
export interface IndexEntry {
  remoteId: string;
  /** Base version for conflict detection. */
  md5: Md5;
  mtimeMs: number;
  size: number;
}

export type FileIndex = Record<string, IndexEntry>;

/** Outcome of the three-way decision rule (DESIGN §5.3). */
export type SyncAction = "upload" | "download" | "none" | "conflict";

export type LogAction = "RUN" | "UPLOAD" | "DOWNLOAD" | "SKIP" | "CONFLICT" | "WARN" | "ERROR";

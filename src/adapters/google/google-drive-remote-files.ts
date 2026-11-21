import { MAX_FILE_SIZE_BYTES, ROOT_FOLDER_NAME } from "../../domain/constants";
import { SyncAbortError } from "../../domain/errors";
import { isExcludedPath, isValidName } from "../../domain/exclusions";
import { basename, dirname, joinPath } from "../../domain/paths";
import type { RemoteFile } from "../../domain/types";
import type { Clock } from "../../ports/clock";
import type { HttpTransport } from "../../ports/http-transport";
import type {
  ConnectResult,
  RemoteFiles,
  RemoteListing,
  SkippedItem,
} from "../../ports/remote-files";
import type { DriveCache } from "../../ports/state-store";
import { DriveApi, type DriveFile } from "./drive-api";
import { DriveHttpError, driveRetryPolicy } from "./drive-errors";
import {
  FOLDER_MIME_TYPE,
  GOOGLE_NATIVE_MIME_PREFIX,
  IS_FOLDER,
  NOT_TRASHED,
  and,
  inParents,
  modifiedAfter,
  nameEquals,
} from "./drive-query";
import { HttpClient } from "./http-client";
import { OAuthTokenProvider, type CredentialsProvider } from "./oauth-token-provider";

export interface GoogleDriveRemoteFilesOptions {
  transport: HttpTransport;
  credentials: CredentialsProvider;
  /** Live reference into persisted state; this adapter owns its contents. */
  cache: () => DriveCache;
  /** Name of the vault folder inside `obsidian/`. */
  vaultFolderName: () => string;
  clock: Clock;
  random?: () => number;
}

interface PathedFile {
  file: DriveFile;
  path: string;
}

const isFolder = (file: DriveFile) => file.mimeType === FOLDER_MIME_TYPE;
const byCreatedTime = (a: DriveFile, b: DriveFile) =>
  Date.parse(a.createdTime) - Date.parse(b.createdTime);

/**
 * `RemoteFiles` on Google Drive v3. Maps vault-relative paths onto Drive's ID/parent graph
 * under `My Drive/obsidian/<vault folder>/` (DESIGN §6).
 */
export class GoogleDriveRemoteFiles implements RemoteFiles {
  private readonly http: HttpClient;
  private readonly api: DriveApi;
  private readonly tokens: OAuthTokenProvider;
  /** One in-flight resolution per folder path per run, so parallel uploads create it once. */
  private readonly folderResolutions = new Map<string, Promise<string>>();

  constructor(private readonly options: GoogleDriveRemoteFilesOptions) {
    const retryPolicy = driveRetryPolicy(options.clock, options.random ?? Math.random);
    this.http = new HttpClient(options.transport);
    this.tokens = new OAuthTokenProvider(
      this.http,
      options.credentials,
      options.clock,
      retryPolicy,
    );
    this.api = new DriveApi(this.http, this.tokens, retryPolicy);
  }

  private get cache(): DriveCache {
    return this.options.cache();
  }

  async connect(): Promise<ConnectResult> {
    this.http.startRun();
    this.folderResolutions.clear();
    await this.tokens.getAccessToken();

    const warnings: string[] = [];
    const folderName = this.options.vaultFolderName();
    let vaultFolderId = await this.validCachedVaultFolder(folderName);
    if (vaultFolderId === null) {
      const rootId = await this.resolveRootFolder(warnings);
      vaultFolderId = await this.resolveChildFolder(rootId, folderName, warnings);
    }

    const vaultFolderReplaced = this.cache.vaultFolderId !== vaultFolderId;
    if (vaultFolderReplaced) {
      this.cache.vaultFolderId = vaultFolderId;
      this.cache.folderIds = {};
    }

    const syncStartTimeMs = this.http.serverTimeMs;
    if (syncStartTimeMs === null) {
      throw new SyncAbortError("Couldn't read the time from Google's servers. Try again.");
    }
    return { syncStartTimeMs, vaultFolderReplaced, warnings };
  }

  async listAll(): Promise<RemoteListing> {
    const skipped: SkippedItem[] = [];
    const files: PathedFile[] = [];
    const folderIds: Record<string, string> = {};
    const queue: [string, string][] = [[this.vaultFolderId(), ""]];

    for (let next = queue.shift(); next !== undefined; next = queue.shift()) {
      const [folderId, folderPath] = next;
      for (const child of await this.api.list(and(inParents(folderId), NOT_TRASHED))) {
        const path = joinPath(folderPath, child.name);
        if (!isFolder(child)) {
          files.push({ file: child, path });
          continue;
        }
        const reason = folderSkipReason(child.name, path);
        if (reason !== null) {
          skipped.push({ path, reason });
          continue;
        }
        folderIds[path] = child.id;
        queue.push([child.id, path]);
      }
    }

    this.cache.folderIds = folderIds;
    return toListing(files, skipped);
  }

  async listChangedSince(sinceMs: number): Promise<RemoteListing> {
    const changed = await this.api.list(and(modifiedAfter(sinceMs), NOT_TRASHED));
    const skipped: SkippedItem[] = [];
    const pathById = new Map<string, string>([[this.vaultFolderId(), ""]]);
    for (const [path, id] of Object.entries(this.cache.folderIds)) pathById.set(id, path);

    // Resolve new folders until stable; anything whose parent stays unknown is outside the vault.
    const pending = changed.filter((file) => isFolder(file) && !pathById.has(file.id));
    for (let progress = true; progress;) {
      progress = false;
      for (const folder of [...pending]) {
        const parentPath = parentPathOf(folder, pathById);
        if (parentPath === undefined) continue;
        pending.splice(pending.indexOf(folder), 1);
        progress = true;
        const path = joinPath(parentPath, folder.name);
        const reason = folderSkipReason(folder.name, path);
        if (reason !== null) {
          skipped.push({ path, reason });
          continue;
        }
        pathById.set(folder.id, path);
        this.cache.folderIds[path] = folder.id;
      }
    }

    const files: PathedFile[] = [];
    for (const file of changed) {
      if (isFolder(file)) continue;
      const parentPath = parentPathOf(file, pathById);
      if (parentPath !== undefined) files.push({ file, path: joinPath(parentPath, file.name) });
    }
    return toListing(files, skipped);
  }

  async find(path: string): Promise<RemoteFile | null> {
    const parentPath = dirname(path);
    const parentId = parentPath === "" ? this.vaultFolderId() : this.cache.folderIds[parentPath];
    if (parentId === undefined) return null;
    const name = basename(path);
    const matches = (
      await this.api.list(and(inParents(parentId), nameEquals(name), NOT_TRASHED))
    ).filter((file) => file.name === name && skipReason(file, path) === null);
    const oldest = matches.sort(byCreatedTime)[0];
    return oldest === undefined ? null : toRemoteFile(oldest, path);
  }

  async upload(path: string, data: ArrayBuffer, remoteId?: string): Promise<RemoteFile> {
    if (remoteId !== undefined) {
      try {
        const updated = await this.api.updateFile(remoteId, data);
        if (updated.trashed !== true) return toRemoteFile(updated, path);
      } catch (error) {
        // A stale ID (deleted file) falls through to create; anything else is a real failure.
        if (!(error instanceof DriveHttpError && error.status === 404)) throw error;
      }
    }
    const parentId = await this.ensureFolder(dirname(path));
    return toRemoteFile(await this.api.createFile(basename(path), parentId, data), path);
  }

  download(remoteId: string): Promise<ArrayBuffer> {
    return this.api.download(remoteId);
  }

  private vaultFolderId(): string {
    const id = this.cache.vaultFolderId;
    if (id === null) throw new Error("connect() must be called before other operations");
    return id;
  }

  private async validCachedVaultFolder(folderName: string): Promise<string | null> {
    const id = this.cache.vaultFolderId;
    if (id === null) return null;
    const folder = await this.api.get(id);
    const valid =
      folder !== null && folder.trashed !== true && isFolder(folder) && folder.name === folderName;
    return valid ? id : null;
  }

  /** The `obsidian` folder in My Drive root, matched case-insensitively (PRD FR-4). */
  private async resolveRootFolder(warnings: string[]): Promise<string> {
    const candidates = (await this.api.list(and(inParents("root"), IS_FOLDER, NOT_TRASHED)))
      .filter((folder) => folder.name.toLowerCase() === ROOT_FOLDER_NAME)
      .sort(byCreatedTime);
    return this.pickOrCreateFolder(candidates, ROOT_FOLDER_NAME, "root", warnings);
  }

  private async resolveChildFolder(
    parentId: string,
    name: string,
    warnings?: string[],
  ): Promise<string> {
    const candidates = (
      await this.api.list(and(inParents(parentId), IS_FOLDER, nameEquals(name), NOT_TRASHED))
    )
      .filter((folder) => folder.name === name)
      .sort(byCreatedTime);
    return this.pickOrCreateFolder(candidates, name, parentId, warnings);
  }

  private async pickOrCreateFolder(
    sortedCandidates: DriveFile[],
    name: string,
    parentId: string,
    warnings?: string[],
  ): Promise<string> {
    const [oldest] = sortedCandidates;
    if (oldest === undefined) return (await this.api.createFolder(name, parentId)).id;
    if (sortedCandidates.length > 1) {
      warnings?.push(
        `Found ${sortedCandidates.length} folders named "${oldest.name}" in Google Drive. Using the oldest.`,
      );
    }
    return oldest.id;
  }

  /** The Drive ID of the folder at `path`, creating missing folders (DESIGN §6.3). */
  private ensureFolder(path: string): Promise<string> {
    if (path === "") return Promise.resolve(this.vaultFolderId());
    let resolution = this.folderResolutions.get(path);
    if (resolution === undefined) {
      resolution = this.resolveFolder(path);
      this.folderResolutions.set(path, resolution);
      resolution.catch(() => this.folderResolutions.delete(path));
    }
    return resolution;
  }

  private async resolveFolder(path: string): Promise<string> {
    const parentId = await this.ensureFolder(dirname(path));
    const cachedId = this.cache.folderIds[path];
    if (cachedId !== undefined) {
      const folder = await this.api.get(cachedId);
      if (folder !== null && folder.trashed !== true && isFolder(folder)) return cachedId;
      delete this.cache.folderIds[path];
    }
    const id = await this.resolveChildFolder(parentId, basename(path));
    this.cache.folderIds[path] = id;
    return id;
  }
}

function parentPathOf(file: DriveFile, pathById: Map<string, string>): string | undefined {
  const parentId = file.parents?.[0];
  return parentId === undefined ? undefined : pathById.get(parentId);
}

function folderSkipReason(name: string, path: string): string | null {
  if (!isValidName(name)) return "name not allowed in Obsidian";
  if (isExcludedPath(path)) return "excluded";
  return null;
}

function skipReason(file: DriveFile, path: string): string | null {
  if (file.mimeType.startsWith(GOOGLE_NATIVE_MIME_PREFIX)) return "Google-native file";
  if (!isValidName(file.name)) return "name not allowed in Obsidian";
  if (isExcludedPath(path)) return "excluded";
  if (Number(file.size ?? 0) > MAX_FILE_SIZE_BYTES) return "larger than 100 MB";
  if (file.md5Checksum === undefined) return "no checksum";
  return null;
}

function toRemoteFile(file: DriveFile, path: string): RemoteFile {
  return {
    path,
    remoteId: file.id,
    md5: file.md5Checksum ?? "",
    modifiedTimeMs: Date.parse(file.modifiedTime),
    size: Number(file.size ?? 0),
  };
}

/** Applies skip rules and resolves duplicate paths to the oldest file (DESIGN §6.2). */
function toListing(files: PathedFile[], skipped: SkippedItem[]): RemoteListing {
  const byPath = new Map<string, DriveFile[]>();
  for (const { file, path } of files) {
    const reason = skipReason(file, path);
    if (reason !== null) {
      skipped.push({ path, reason });
      continue;
    }
    byPath.set(path, [...(byPath.get(path) ?? []), file]);
  }

  const result = new Map<string, RemoteFile>();
  const warnings: string[] = [];
  for (const [path, candidates] of byPath) {
    const [oldest] = candidates.sort(byCreatedTime);
    if (oldest === undefined) continue;
    if (candidates.length > 1) {
      warnings.push(
        `Found ${candidates.length} files at "${path}" in Google Drive. Using the oldest.`,
      );
    }
    result.set(path, toRemoteFile(oldest, path));
  }
  return { files: result, skipped, warnings };
}

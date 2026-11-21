import { normalizePath, type Vault } from "obsidian";
import { dirname } from "../../domain/paths";
import type { LocalFileInfo } from "../../domain/types";
import type { LocalFiles } from "../../ports/local-files";

/** `LocalFiles` on Obsidian's Vault API. */
export class ObsidianLocalFiles implements LocalFiles {
  constructor(private readonly vault: Vault) {}

  list(): Promise<LocalFileInfo[]> {
    return Promise.resolve(
      this.vault
        .getFiles()
        .map((file) => ({ path: file.path, mtimeMs: file.stat.mtime, size: file.stat.size })),
    );
  }

  async stat(path: string): Promise<LocalFileInfo | null> {
    // Read from disk rather than the cached TFile stat: the passes rely on fresh values.
    const stat = await this.vault.adapter.stat(normalizePath(path));
    return stat?.type === "file" ? { path, mtimeMs: stat.mtime, size: stat.size } : null;
  }

  async read(path: string): Promise<ArrayBuffer> {
    const file = this.vault.getFileByPath(normalizePath(path));
    if (file === null) throw new Error(`File not found: ${path}`);
    return this.vault.readBinary(file);
  }

  async write(path: string, data: ArrayBuffer): Promise<LocalFileInfo> {
    const normalized = normalizePath(path);
    const existing = this.vault.getFileByPath(normalized);
    if (existing !== null) {
      await this.vault.modifyBinary(existing, data);
    } else {
      await this.ensureFolder(dirname(normalized));
      await this.vault.createBinary(normalized, data);
    }
    const info = await this.stat(normalized);
    if (info === null) throw new Error(`File missing after write: ${path}`);
    return info;
  }

  private async ensureFolder(path: string): Promise<void> {
    if (path === "" || this.vault.getFolderByPath(path) !== null) return;
    await this.ensureFolder(dirname(path));
    try {
      await this.vault.createFolder(path);
    } catch (error) {
      // A parallel download may have created it first.
      if (this.vault.getFolderByPath(path) === null) throw error;
    }
  }
}

import type { LocalFileInfo } from "../domain/types";

/** The vault's files, addressed by vault-relative path. */
export interface LocalFiles {
  /** Every file in the vault, with current stat. */
  list(): Promise<LocalFileInfo[]>;
  /** Fresh stat from disk, or `null` if the file doesn't exist. */
  stat(path: string): Promise<LocalFileInfo | null>;
  read(path: string): Promise<ArrayBuffer>;
  /** Creates or overwrites the file (and missing parent folders); returns its new stat. */
  write(path: string, data: ArrayBuffer): Promise<LocalFileInfo>;
}

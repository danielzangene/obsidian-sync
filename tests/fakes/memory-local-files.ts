import type { LocalFileInfo } from "../../src/domain/types";
import type { Clock } from "../../src/ports/clock";
import type { LocalFiles } from "../../src/ports/local-files";

interface Entry {
  data: Uint8Array;
  mtimeMs: number;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** In-memory vault. `mtime` comes from the device clock, like a real file system. */
export class MemoryLocalFiles implements LocalFiles {
  private readonly entries = new Map<string, Entry>();
  /** Called after a file's bytes are read; lets tests edit files mid-run. */
  onRead: ((path: string) => void) | undefined;

  constructor(private readonly clock: Clock) {}

  list(): Promise<LocalFileInfo[]> {
    return Promise.resolve([...this.entries.keys()].map((path) => this.info(path)));
  }

  stat(path: string): Promise<LocalFileInfo | null> {
    return Promise.resolve(this.entries.has(path) ? this.info(path) : null);
  }

  read(path: string): Promise<ArrayBuffer> {
    const entry = this.entries.get(path);
    if (entry === undefined) return Promise.reject(new Error(`No such file: ${path}`));
    const copy = entry.data.slice().buffer;
    this.onRead?.(path);
    return Promise.resolve(copy);
  }

  write(path: string, data: ArrayBuffer): Promise<LocalFileInfo> {
    this.set(path, new Uint8Array(data.slice(0)));
    return Promise.resolve(this.info(path));
  }

  // ── Test helpers ──

  /** Creates or edits a file as the user would. */
  put(path: string, text: string): void {
    this.set(path, encoder.encode(text));
  }

  text(path: string): string | undefined {
    const entry = this.entries.get(path);
    return entry === undefined ? undefined : decoder.decode(entry.data);
  }

  snapshot(): Record<string, string> {
    return Object.fromEntries([...this.entries].map(([p, e]) => [p, decoder.decode(e.data)]));
  }

  paths(): string[] {
    return [...this.entries.keys()].sort();
  }

  private set(path: string, data: Uint8Array): void {
    const previous = this.entries.get(path)?.mtimeMs ?? -Infinity;
    // Like real file systems, a write always moves mtime forward.
    this.entries.set(path, { data, mtimeMs: Math.max(this.clock.now(), previous + 1) });
  }

  private info(path: string): LocalFileInfo {
    const entry = this.entries.get(path) as Entry;
    return { path, mtimeMs: entry.mtimeMs, size: entry.data.byteLength };
  }
}

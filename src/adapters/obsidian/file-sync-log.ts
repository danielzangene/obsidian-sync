import type { DataAdapter } from "obsidian";
import { LOG_MAX_LINES } from "../../domain/constants";
import type { LogAction } from "../../domain/types";
import type { Clock } from "../../ports/clock";
import type { SyncLog } from "../../ports/sync-log";

/** `<time> <ACTION> <path> <reason>`, one action per line (PRD §8). */
export function formatLogLine(
  timeMs: number,
  action: LogAction,
  path: string,
  reason: string,
): string {
  return `${new Date(timeMs).toISOString()} ${action} ${path === "" ? "-" : path} ${reason}`;
}

/** Keeps the last `LOG_MAX_LINES` lines in a file in the plugin folder (never synced). */
export class FileSyncLog implements SyncLog {
  private pending: string[] = [];

  constructor(
    private readonly adapter: DataAdapter,
    private readonly filePath: string,
    private readonly clock: Clock,
  ) {}

  record(action: LogAction, path: string, reason: string): void {
    this.pending.push(formatLogLine(this.clock.now(), action, path, reason));
  }

  async flush(): Promise<void> {
    if (this.pending.length === 0) return;
    const existing = (await this.adapter.exists(this.filePath))
      ? (await this.adapter.read(this.filePath)).split("\n").filter((line) => line !== "")
      : [];
    const lines = [...existing, ...this.pending].slice(-LOG_MAX_LINES);
    this.pending = [];
    await this.adapter.write(this.filePath, `${lines.join("\n")}\n`);
  }
}

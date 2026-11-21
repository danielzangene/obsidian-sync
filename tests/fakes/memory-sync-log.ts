import type { LogAction } from "../../src/domain/types";
import type { SyncLog } from "../../src/ports/sync-log";

export class MemorySyncLog implements SyncLog {
  readonly lines: string[] = [];

  record(action: LogAction, path: string, reason: string): void {
    this.lines.push(`${action} ${path} ${reason}`);
  }

  flush(): Promise<void> {
    return Promise.resolve();
  }
}

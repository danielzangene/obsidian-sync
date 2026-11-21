import type { LogAction } from "../domain/types";

/** Sync activity log. The API only takes paths and reasons, so contents and tokens can't leak. */
export interface SyncLog {
  record(action: LogAction, path: string, reason: string): void;
  flush(): Promise<void>;
}

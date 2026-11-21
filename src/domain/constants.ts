/** Tunables from docs/DESIGN.md §4.3. */

/** `lastSyncTime` value meaning "never synced". */
export const EPOCH_ISO = "2000-01-01T00:00:00.000Z";
export const EPOCH_MS = Date.parse(EPOCH_ISO);

/** Re-read window on the remote query, covering Drive search lag. */
export const REMOTE_QUERY_OVERLAP_MS = 5 * 60 * 1000;

export const MAX_CONCURRENT_TRANSFERS = 4;

/** Retries after the first attempt. */
export const MAX_RETRIES = 3;

export const RESUMABLE_UPLOAD_THRESHOLD_BYTES = 5 * 1024 * 1024;

/** Files larger than this are skipped and logged (PRD OQ-4). */
export const MAX_FILE_SIZE_BYTES = 100 * 1024 * 1024;

/** Persist the sync index after this many transfers. */
export const INDEX_CHECKPOINT_INTERVAL = 100;

export const LOG_MAX_LINES = 500;

/** Name of the top-level Drive folder that holds all vaults. */
export const ROOT_FOLDER_NAME = "obsidian";

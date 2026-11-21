import { conflictCopyPath } from "../domain/conflict-name";
import type { RemoteFile } from "../domain/types";
import { md5 } from "../lib/md5";
import { indexEntry, type LocalSnapshot, type RunContext } from "./run-context";

/** Downloads a remote file and verifies it against its checksum. */
export async function downloadVerified(ctx: RunContext, remote: RemoteFile): Promise<ArrayBuffer> {
  const data = await ctx.remote.download(remote.remoteId);
  if (md5(data) !== remote.md5) throw new Error("Downloaded content doesn't match its checksum");
  return data;
}

/**
 * Keeps both versions (DESIGN §5.6): the remote version goes to a conflict copy next to the
 * file, the local version stays the main file and is uploaded.
 */
export async function resolveConflict(
  ctx: RunContext,
  path: string,
  local: LocalSnapshot,
  remote: RemoteFile,
  remoteData?: ArrayBuffer,
): Promise<void> {
  const data = remoteData ?? (await downloadVerified(ctx, remote));
  const copyPath = await writeConflictCopy(ctx, path, remote, data);
  const uploaded = await ctx.remote.upload(path, local.data, remote.remoteId);
  ctx.index[path] = indexEntry(uploaded.remoteId, local.md5, local.info);
  ctx.report.conflicts++;
  ctx.log.record("CONFLICT", path, `remote version saved as "${copyPath}"`);
  await ctx.afterTransfer();
}

/**
 * The copy's name depends only on the remote version, so a retried run finds the copy it
 * already wrote and reuses it. A different file with that name gets a counter instead.
 */
async function writeConflictCopy(
  ctx: RunContext,
  path: string,
  remote: RemoteFile,
  data: ArrayBuffer,
): Promise<string> {
  for (let attempt = 1; ; attempt++) {
    const candidate = conflictCopyPath(path, remote.modifiedTimeMs, attempt);
    if ((await ctx.local.stat(candidate)) === null) {
      await ctx.local.write(candidate, data);
      return candidate;
    }
    if (md5(await ctx.local.read(candidate)) === remote.md5) return candidate;
  }
}

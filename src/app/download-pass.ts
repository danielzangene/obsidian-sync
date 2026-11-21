import { MAX_CONCURRENT_TRANSFERS } from "../domain/constants";
import { decide } from "../domain/decide";
import type { LocalFileInfo, RemoteFile } from "../domain/types";
import { md5 } from "../lib/md5";
import { runPool } from "../lib/pool";
import { downloadVerified, resolveConflict } from "./conflict-resolver";
import { indexEntry, recordFailure, type RunContext } from "./run-context";

/** Download pass (DESIGN §5.5): remote changes not handled by the upload pass. */
export async function runDownloadPass(ctx: RunContext): Promise<void> {
  const pending = [...ctx.remoteChanges.values()].filter((file) => !ctx.handled.has(file.path));
  ctx.progress.downloadTotal = pending.length;
  ctx.emitProgress();

  await runPool(pending, MAX_CONCURRENT_TRANSFERS, async (remote) => {
    try {
      await downloadFile(ctx, remote);
    } catch (error) {
      recordFailure(ctx, remote.path, error);
    } finally {
      ctx.progress.downloadDone++;
      ctx.emitProgress();
    }
  });
}

async function downloadFile(ctx: RunContext, remote: RemoteFile): Promise<void> {
  const { path } = remote;
  const base = ctx.index[path];
  if (base?.md5 === remote.md5) {
    // Remote unchanged since this device synced it (e.g. re-seen through the query overlap).
    if (base.remoteId !== remote.remoteId) ctx.index[path] = { ...base, remoteId: remote.remoteId };
    return;
  }

  const info = await ctx.local.stat(path);
  if (info === null) {
    await writeDownload(ctx, remote, await downloadVerified(ctx, remote), "created");
    return;
  }

  const data = await ctx.local.read(path);
  const localMd5 = md5(data);
  const action = decide(localMd5, remote.md5, base?.md5);

  if (action === "none") {
    ctx.index[path] = indexEntry(remote.remoteId, localMd5, info);
  } else if (action === "conflict") {
    await resolveConflict(ctx, path, { data, md5: localMd5, info }, remote);
  } else if (action === "download") {
    await overwriteIfUnchanged(ctx, remote, info, base?.md5);
  }
  // "upload" can't happen here: remote = base returned early above.
}

/**
 * Re-checks the local file right before overwriting it (DESIGN §5.5). If it was edited since it
 * was hashed and no longer matches its base, it becomes a conflict instead of being overwritten.
 */
async function overwriteIfUnchanged(
  ctx: RunContext,
  remote: RemoteFile,
  hashedInfo: LocalFileInfo,
  baseMd5: string | undefined,
): Promise<void> {
  const remoteData = await downloadVerified(ctx, remote);
  const current = await ctx.local.stat(remote.path);
  if (
    current !== null &&
    (current.mtimeMs !== hashedInfo.mtimeMs || current.size !== hashedInfo.size)
  ) {
    const data = await ctx.local.read(remote.path);
    const localMd5 = md5(data);
    if (localMd5 !== baseMd5) {
      await resolveConflict(
        ctx,
        remote.path,
        { data, md5: localMd5, info: current },
        remote,
        remoteData,
      );
      return;
    }
  }
  await writeDownload(ctx, remote, remoteData, "updated");
}

async function writeDownload(
  ctx: RunContext,
  remote: RemoteFile,
  data: ArrayBuffer,
  outcome: "created" | "updated",
): Promise<void> {
  const info = await ctx.local.write(remote.path, data);
  ctx.index[remote.path] = indexEntry(remote.remoteId, remote.md5, info);
  ctx.report.downloaded++;
  ctx.log.record("DOWNLOAD", remote.path, outcome);
  await ctx.afterTransfer();
}

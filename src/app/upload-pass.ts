import { MAX_CONCURRENT_TRANSFERS, MAX_FILE_SIZE_BYTES } from "../domain/constants";
import { decide } from "../domain/decide";
import { isExcludedPath } from "../domain/exclusions";
import type { IndexEntry, RemoteFile } from "../domain/types";
import { md5 } from "../lib/md5";
import { runPool } from "../lib/pool";
import { resolveConflict } from "./conflict-resolver";
import { indexEntry, isTouched, recordFailure, type RunContext } from "./run-context";

/** Upload pass (DESIGN §5.4): every touched, non-excluded local file. */
export async function runUploadPass(ctx: RunContext): Promise<void> {
  const candidates = (await ctx.local.list()).filter(
    (file) => !isExcludedPath(file.path) && isTouched(file, ctx.index[file.path]),
  );
  ctx.progress.uploadTotal = candidates.length;
  ctx.emitProgress();

  await runPool(candidates, MAX_CONCURRENT_TRANSFERS, async (file) => {
    try {
      await uploadFile(ctx, file.path);
    } catch (error) {
      recordFailure(ctx, file.path, error);
    } finally {
      ctx.progress.uploadDone++;
      ctx.emitProgress();
    }
  });
}

async function uploadFile(ctx: RunContext, path: string): Promise<void> {
  // Stat before reading: an edit during the read then shows up as touched next run.
  const info = await ctx.local.stat(path);
  if (info === null) return;
  if (info.size > MAX_FILE_SIZE_BYTES) {
    ctx.handled.add(path);
    ctx.report.skipped++;
    ctx.log.record("SKIP", path, "larger than 100 MB");
    return;
  }

  const data = await ctx.local.read(path);
  const localMd5 = md5(data);
  const base = ctx.index[path];
  if (base?.md5 === localMd5) {
    // Content unchanged (e.g. just downloaded); only the stat moved. Remote changes, if any,
    // are handled by the download pass.
    ctx.index[path] = { ...base, mtimeMs: info.mtimeMs, size: info.size };
    return;
  }

  ctx.handled.add(path);
  const remote =
    ctx.remoteChanges.get(path) ??
    (base !== undefined ? remoteFromIndex(path, base) : await ctx.remote.find(path));
  const action = decide(localMd5, remote?.md5, base?.md5);

  if (action === "upload") {
    const uploaded = await ctx.remote.upload(path, data, remote?.remoteId);
    ctx.index[path] = indexEntry(uploaded.remoteId, localMd5, info);
    ctx.report.uploaded++;
    ctx.log.record("UPLOAD", path, remote === null ? "created" : "updated");
    await ctx.afterTransfer();
  } else if (action === "none" && remote !== null) {
    ctx.index[path] = indexEntry(remote.remoteId, localMd5, info);
    ctx.log.record("SKIP", path, "same content on both sides");
  } else if (action === "conflict" && remote !== null) {
    await resolveConflict(ctx, path, { data, md5: localMd5, info }, remote);
  } else if (action === "download") {
    // Only the remote changed; leave it to the download pass.
    ctx.handled.delete(path);
  }
}

/**
 * The remote side of a file absent from the change set: unchanged since the last sync, so it
 * equals the base. Its modification time is unknown, but it is only needed for conflicts, which
 * can't occur when remote = base.
 */
function remoteFromIndex(path: string, base: IndexEntry): RemoteFile {
  return { path, remoteId: base.remoteId, md5: base.md5, modifiedTimeMs: 0, size: base.size };
}

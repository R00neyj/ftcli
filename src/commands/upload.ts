import path, { posix } from "node:path";
import { collectRemote, compare, select, type Status } from "../compare.js";
import { runPool, type Job, type PoolOptions } from "../parallel.js";
import { scanLocal } from "../scan.js";
import type { Context } from "../session.js";
import { BAK_SUFFIX } from "../transport/types.js";

export interface UploadOpts extends PoolOptions {
  dryRun?: boolean;
  backup: boolean;
}

function uploadJob(ctx: Context, rel: string, status: Status, size: number, backup: boolean): Job {
  const bak = `${rel}${BAK_SUFFIX}`;
  const needsBackup = status === "modified" && backup;
  let backedUp = false;
  return {
    path: rel,
    label: `${status === "modified" ? "M" : "+"} ${rel}`,
    async run(t) {
      if (needsBackup && !backedUp) {
        try {
          await t.remove(bak, true);
          await t.rename(rel, bak);
        } catch (err) {
          const replyLost = (await t.size(bak)) !== null && (await t.size(rel)) === null;
          if (!replyLost) throw err;
        }
        backedUp = true;
      }
      await t.upload(path.join(ctx.cwd, rel), rel);
      const remoteSize = await t.size(rel);
      if (remoteSize === null) console.error(`검증 불가 ${rel}: 원격 크기를 얻지 못함`);
      else if (remoteSize !== size) {
        throw new Error(`VERIFY FAILED: 원격 ${remoteSize}B != 로컬 ${size}B`);
      }
    },
    async abandon(t) {
      if (status === "localOnly") {
        await t.remove(rel, true);
      } else if (backedUp) {
        await t.remove(rel, true);
        await t.rename(bak, rel);
        backedUp = false;
      }
    },
  };
}

export async function upload(ctx: Context, files: string[], opts: UploadOpts): Promise<void> {
  const local = await scanLocal(ctx.cwd, ctx.ig);
  const remote = await collectRemote(ctx.transport, ctx.ig);
  const targets = select(compare(local, remote), files).filter(
    (c) => c.status === "localOnly" || c.status === "modified",
  );
  if (targets.length === 0) {
    console.log("업로드 대상 없음");
    return;
  }

  if (opts.dryRun) {
    for (const c of targets) console.log(`[dry-run] ${c.status === "modified" ? "M" : "+"} ${c.path}`);
    return;
  }

  const newDirs = targets
    .filter((c) => c.status === "localOnly")
    .map((c) => posix.dirname(c.path))
    .filter((d) => d !== ".");
  await ctx.transport.mkdirs(newDirs);

  const jobs = targets.map((c) =>
    uploadJob(ctx, c.path, c.status, local.get(c.path)?.size ?? 0, opts.backup),
  );
  await runPool(ctx, jobs, opts);
}

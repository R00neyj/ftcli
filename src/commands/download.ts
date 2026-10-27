import { copyFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { STATE_DIR } from "../config.js";
import { collectRemote, compare, select, type Status } from "../compare.js";
import { runPool, type Job, type PoolOptions } from "../parallel.js";
import { scanLocal } from "../scan.js";
import { timestamp, type Context } from "../session.js";
import { downloadVerified, removePart } from "../transfer.js";

export interface DownloadOpts extends PoolOptions {
  dryRun?: boolean;
  backup: boolean;
}

function downloadJob(
  cwd: string,
  rel: string,
  status: Status,
  size: number,
  backupRoot: string | null,
): Job {
  const dest = path.join(cwd, rel);
  let saved = false;
  return {
    path: rel,
    label: `${status === "modified" ? "M" : "-"} ${rel}`,
    async run(t) {
      if (backupRoot && !saved) {
        const copy = path.join(backupRoot, rel);
        await mkdir(path.dirname(copy), { recursive: true });
        await copyFile(dest, copy);
        saved = true;
      }
      await downloadVerified(t, rel, dest, size);
    },
    cleanup: () => removePart(dest),
  };
}

export async function download(ctx: Context, files: string[], opts: DownloadOpts): Promise<void> {
  const local = await scanLocal(ctx.cwd, ctx.ig);
  const remote = await collectRemote(ctx.transport, ctx.ig);
  const targets = select(compare(local, remote), files).filter(
    (c) => c.status === "remoteOnly" || c.status === "modified",
  );
  if (targets.length === 0) {
    console.log("다운로드 대상 없음");
    return;
  }

  if (opts.dryRun) {
    for (const c of targets) console.log(`[dry-run] ${c.status === "modified" ? "M" : "-"} ${c.path}`);
    return;
  }

  const backupRoot = path.join(ctx.cwd, STATE_DIR, "backups", timestamp());
  const jobs = targets.map((c) =>
    downloadJob(
      ctx.cwd,
      c.path,
      c.status,
      remote.get(c.path)?.size ?? 0,
      c.status === "modified" && opts.backup ? backupRoot : null,
    ),
  );
  await runPool(ctx, jobs, opts);
}

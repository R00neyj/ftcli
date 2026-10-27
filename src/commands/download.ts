import { copyFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { STATE_DIR } from "../config.js";
import { collectRemote, compare, select } from "../compare.js";
import { scanLocal } from "../scan.js";
import { timestamp, type Context } from "../session.js";

export async function download(
  ctx: Context,
  files: string[],
  opts: { dryRun?: boolean; backup: boolean },
): Promise<void> {
  const local = await scanLocal(ctx.cwd, ctx.ig);
  const remote = await collectRemote(ctx.transport, ctx.ig);
  const targets = select(compare(local, remote), files).filter(
    (c) => c.status === "remoteOnly" || c.status === "modified",
  );
  if (targets.length === 0) {
    console.log("다운로드 대상 없음");
    return;
  }

  const backupRoot = path.join(ctx.cwd, STATE_DIR, "backups", timestamp());
  let failed = 0;
  for (const { path: rel, status } of targets) {
    const mark = status === "modified" ? "M" : "-";
    if (opts.dryRun) {
      console.log(`[dry-run] ${mark} ${rel}`);
      continue;
    }
    const dest = path.join(ctx.cwd, rel);
    try {
      if (status === "modified" && opts.backup) {
        const saved = path.join(backupRoot, rel);
        await mkdir(path.dirname(saved), { recursive: true });
        await copyFile(dest, saved);
      }
      await ctx.transport.download(rel, dest);
      console.log(`${mark} ${rel}`);
    } catch (err) {
      failed++;
      console.error(`실패 ${rel}: ${(err as Error).message}`);
    }
  }
  if (failed > 0) process.exitCode = 2;
}

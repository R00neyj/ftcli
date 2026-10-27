import path from "node:path";
import { collectRemote, compare, select } from "../compare.js";
import { scanLocal } from "../scan.js";
import type { Context } from "../session.js";
import { BAK_SUFFIX } from "../transport/types.js";

export async function upload(
  ctx: Context,
  files: string[],
  opts: { dryRun?: boolean; backup: boolean },
): Promise<void> {
  const local = await scanLocal(ctx.cwd, ctx.ig);
  const remote = await collectRemote(ctx.transport, ctx.ig);
  const targets = select(compare(local, remote), files).filter(
    (c) => c.status === "localOnly" || c.status === "modified",
  );
  if (targets.length === 0) {
    console.log("업로드 대상 없음");
    return;
  }

  let failed = 0;
  for (const { path: rel, status } of targets) {
    const mark = status === "modified" ? "M" : "+";
    if (opts.dryRun) {
      console.log(`[dry-run] ${mark} ${rel}`);
      continue;
    }
    const bak = `${rel}${BAK_SUFFIX}`;
    const needsBackup = status === "modified" && opts.backup;
    try {
      if (needsBackup) {
        await ctx.transport.remove(bak, true);
        await ctx.transport.rename(rel, bak);
      }
      try {
        await ctx.transport.upload(path.join(ctx.cwd, rel), rel);
      } catch (err) {
        if (needsBackup) await ctx.transport.rename(bak, rel).catch(() => {});
        throw err;
      }
      console.log(`${mark} ${rel}`);
    } catch (err) {
      failed++;
      console.error(`실패 ${rel}: ${(err as Error).message}`);
    }
  }
  if (failed > 0) process.exitCode = 2;
}

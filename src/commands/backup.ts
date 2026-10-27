import path from "node:path";
import { STATE_DIR } from "../config.js";
import { collectRemote, select } from "../compare.js";
import { timestamp, type Context } from "../session.js";

export async function backup(ctx: Context, paths: string[]): Promise<void> {
  const remote = await collectRemote(ctx.transport, ctx.ig);
  const targets = select(
    [...remote.keys()].map((p) => ({ path: p })),
    paths,
  );
  if (targets.length === 0) {
    console.log("백업 대상 없음");
    return;
  }

  const root = path.join(ctx.cwd, STATE_DIR, "backups", timestamp());
  let failed = 0;
  for (const { path: rel } of targets) {
    try {
      await ctx.transport.download(rel, path.join(root, rel));
    } catch (err) {
      failed++;
      console.error(`실패 ${rel}: ${(err as Error).message}`);
    }
  }
  console.log(`백업 ${targets.length - failed}/${targets.length}건 → ${root}`);
  if (failed > 0) process.exitCode = 2;
}

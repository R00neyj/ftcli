import path from "node:path";
import { STATE_DIR } from "../config.js";
import { collectRemote, select } from "../compare.js";
import { runPool, type Job, type PoolOptions } from "../parallel.js";
import { timestamp, type Context } from "../session.js";
import { downloadVerified, removePart } from "../transfer.js";

export async function backup(ctx: Context, paths: string[], opts: PoolOptions): Promise<void> {
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
  const jobs: Job[] = targets.map(({ path: rel }) => {
    const dest = path.join(root, rel);
    return {
      path: rel,
      label: rel,
      run: (t) => downloadVerified(t, rel, dest, remote.get(rel)?.size ?? 0),
      cleanup: () => removePart(dest),
    };
  });
  console.log(`백업 위치: ${root}`);
  await runPool(ctx, jobs, opts);
}

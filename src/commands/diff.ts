import { collectRemote, compare, select, verifyByHash, type Status } from "../compare.js";
import { scanLocal } from "../scan.js";
import type { Context } from "../session.js";

const MARK: Record<Status, string> = {
  localOnly: "+",
  remoteOnly: "-",
  modified: "M",
  same: " ",
};

export async function diff(ctx: Context, files: string[], opts: { verify?: boolean }): Promise<void> {
  const local = await scanLocal(ctx.cwd, ctx.ig);
  const remote = await collectRemote(ctx.transport, ctx.ig);
  let changes = select(compare(local, remote), files);
  if (opts.verify) changes = await verifyByHash(changes, ctx.cwd, ctx.transport);

  const diffs = changes.filter((c) => c.status !== "same");
  for (const c of diffs) console.log(`${MARK[c.status]} ${c.path}`);
  if (diffs.length === 0) console.log("차이 없음");
  else console.log(`\n${diffs.length}건 (+ 로컬에만 / - 원격에만 / M 다름)`);
}

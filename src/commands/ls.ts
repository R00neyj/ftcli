import { printJson } from "../cli.js";
import type { Context } from "../session.js";

export async function ls(
  ctx: Context,
  dir: string,
  opts: { recursive?: boolean; json?: boolean },
): Promise<void> {
  const entries = await ctx.transport.list(dir, Boolean(opts.recursive));
  entries.sort((a, b) => a.path.localeCompare(b.path));
  if (opts.json) {
    printJson(entries.map((e) => ({ path: e.path, size: e.size, isDir: e.isDir })));
    return;
  }
  for (const e of entries) {
    console.log(`${e.isDir ? "d" : "-"} ${String(e.size).padStart(10)} ${e.path}${e.isDir ? "/" : ""}`);
  }
}

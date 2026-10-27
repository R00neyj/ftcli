import type { Context } from "../session.js";

export async function ls(ctx: Context, dir: string, opts: { recursive?: boolean }): Promise<void> {
  const entries = await ctx.transport.list(dir, Boolean(opts.recursive));
  entries.sort((a, b) => a.path.localeCompare(b.path));
  for (const e of entries) {
    console.log(`${e.isDir ? "d" : "-"} ${String(e.size).padStart(10)} ${e.path}${e.isDir ? "/" : ""}`);
  }
}

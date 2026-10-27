import type { Ignore } from "ignore";
import { readdir, stat } from "node:fs/promises";
import path from "node:path";

export interface FileInfo {
  size: number;
}

export async function scanLocal(root: string, ig: Ignore): Promise<Map<string, FileInfo>> {
  const out = new Map<string, FileInfo>();
  const walk = async (rel: string): Promise<void> => {
    for (const ent of await readdir(path.join(root, rel), { withFileTypes: true })) {
      const entRel = rel ? `${rel}/${ent.name}` : ent.name;
      if (ent.isDirectory()) {
        if (!ig.ignores(`${entRel}/`)) await walk(entRel);
      } else if (ent.isFile() && !ig.ignores(entRel)) {
        out.set(entRel, { size: (await stat(path.join(root, entRel))).size });
      }
    }
  };
  await walk("");
  return out;
}

import type { Ignore } from "ignore";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { FileInfo } from "./scan.js";
import { BAK_SUFFIX, type Transport } from "./transport/types.js";

export type Status = "localOnly" | "remoteOnly" | "modified" | "same";

export interface Change {
  path: string;
  status: Status;
}

export async function collectRemote(t: Transport, ig: Ignore): Promise<Map<string, FileInfo>> {
  const files = (await t.list("", true)).filter((e) => !e.isDir && !ig.ignores(e.path));
  const paths = new Set(files.map((e) => e.path));
  const out = new Map<string, FileInfo>();
  for (const e of files) {
    const isBackupOfExisting =
      e.path.endsWith(BAK_SUFFIX) && paths.has(e.path.slice(0, -BAK_SUFFIX.length));
    if (!isBackupOfExisting) out.set(e.path, { size: e.size });
  }
  return out;
}

export function compare(local: Map<string, FileInfo>, remote: Map<string, FileInfo>): Change[] {
  const all = [...new Set([...local.keys(), ...remote.keys()])].sort();
  return all.map((p) => {
    const l = local.get(p);
    const r = remote.get(p);
    const status: Status = !r
      ? "localOnly"
      : !l
        ? "remoteOnly"
        : l.size !== r.size
          ? "modified"
          : "same";
    return { path: p, status };
  });
}

export function select<T extends { path: string }>(items: T[], selections: string[]): T[] {
  if (selections.length === 0) return items;
  const prefixes = selections.map((s) => s.replace(/\\/g, "/").replace(/\/+$/, ""));
  return items.filter((i) => prefixes.some((s) => i.path === s || i.path.startsWith(`${s}/`)));
}

async function sha256(file: string): Promise<string> {
  return createHash("sha256")
    .update(await readFile(file))
    .digest("hex");
}

export async function verifyByHash(
  changes: Change[],
  cwd: string,
  t: Transport,
): Promise<Change[]> {
  const tmp = await mkdtemp(path.join(tmpdir(), "ftcli-"));
  try {
    const out: Change[] = [];
    for (const c of changes) {
      if (c.status !== "same") {
        out.push(c);
        continue;
      }
      const tmpFile = path.join(tmp, "remote.bin");
      await t.download(c.path, tmpFile);
      const same = (await sha256(tmpFile)) === (await sha256(path.join(cwd, c.path)));
      out.push({ path: c.path, status: same ? "same" : "modified" });
    }
    return out;
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}

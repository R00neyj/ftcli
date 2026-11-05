import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { STATE_DIR } from "./config.js";
import type { RemoteStat } from "./transport/types.js";

export interface BaseEntry {
  size: number;
  mtime: string | null;
  sha256: string;
  pulledAt: string;
}

interface StateFile {
  version: 1;
  files: Record<string, BaseEntry>;
}

export interface LocalInfo {
  size: number;
  sha256: string;
}

export type RemoteVerdict = "same" | "weak-same" | "changed" | "deleted";

export type FileState =
  | "clean"
  | "local-modified"
  | "remote-changed"
  | "conflict"
  | "local-missing"
  | "remote-deleted";

export const statePath = (cwd: string): string => path.join(cwd, STATE_DIR, "state.json");

export function normalizeRel(arg: string): string {
  const parts = arg
    .replace(/\\/g, "/")
    .split("/")
    .filter((s) => s !== "" && s !== ".");
  if (parts.includes("..")) throw new Error(`허용되지 않는 경로: ${arg}`);
  return parts.join("/");
}

export class WorkSet {
  private constructor(
    private readonly cwd: string,
    private readonly files: Map<string, BaseEntry>,
  ) {}

  static async load(cwd: string): Promise<WorkSet> {
    let raw: string;
    try {
      raw = await readFile(statePath(cwd), "utf8");
    } catch {
      return new WorkSet(cwd, new Map());
    }
    const parsed = JSON.parse(raw) as StateFile;
    return new WorkSet(cwd, new Map(Object.entries(parsed.files ?? {})));
  }

  get(rel: string): BaseEntry | undefined {
    return this.files.get(rel);
  }

  set(rel: string, entry: BaseEntry): void {
    this.files.set(rel, entry);
  }

  delete(rel: string): void {
    this.files.delete(rel);
  }

  paths(): string[] {
    return [...this.files.keys()].sort();
  }

  async save(): Promise<void> {
    const file = statePath(this.cwd);
    await mkdir(path.dirname(file), { recursive: true });
    const data: StateFile = {
      version: 1,
      files: Object.fromEntries([...this.files].sort(([a], [b]) => a.localeCompare(b))),
    };
    const tmp = `${file}.tmp`;
    await writeFile(tmp, `${JSON.stringify(data, null, 2)}\n`);
    await rename(tmp, file);
  }
}

export function hashFile(file: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const h = createHash("sha256");
    createReadStream(file)
      .on("error", reject)
      .on("data", (chunk) => h.update(chunk))
      .on("end", () => resolve(h.digest("hex")));
  });
}

export async function localInfo(cwd: string, rel: string): Promise<LocalInfo | null> {
  const file = path.join(cwd, rel);
  try {
    const st = await stat(file);
    if (!st.isFile()) return null;
    return { size: st.size, sha256: await hashFile(file) };
  } catch {
    return null;
  }
}

export function remoteVerdict(base: BaseEntry, remote: RemoteStat | null): RemoteVerdict {
  if (!remote) return "deleted";
  if (remote.size !== base.size) return "changed";
  if (remote.mtime === null || base.mtime === null) return "weak-same";
  return remote.mtime === base.mtime ? "same" : "changed";
}

export function classify(
  base: BaseEntry,
  local: LocalInfo | null,
  remote: RemoteStat | null,
): FileState {
  if (!local) return "local-missing";
  const verdict = remoteVerdict(base, remote);
  if (verdict === "deleted") return "remote-deleted";
  const localModified = local.sha256 !== base.sha256;
  if (verdict === "changed") return localModified ? "conflict" : "remote-changed";
  return localModified ? "local-modified" : "clean";
}

export async function recordBase(
  ws: WorkSet,
  cwd: string,
  rel: string,
  remote: RemoteStat,
): Promise<void> {
  const local = await localInfo(cwd, rel);
  if (!local) throw new Error(`로컬 파일 없음: ${rel}`);
  ws.set(rel, {
    size: local.size,
    mtime: remote.mtime,
    sha256: local.sha256,
    pulledAt: new Date().toISOString(),
  });
}

import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { STATE_DIR } from "./config.js";
import type { Context } from "./session.js";
import { BAK_SUFFIX } from "./transport/types.js";

export interface IndexEntry {
  path: string;
  size: number;
  mtime?: string;
}

export interface IndexFile {
  version: 1;
  builtAt: string;
  entries: IndexEntry[];
}

export const indexPath = (cwd: string): string => path.join(cwd, STATE_DIR, "index.json");

export const underDir = (dir: string, p: string): boolean =>
  dir === "" || p === dir || p.startsWith(`${dir}/`);

export async function readIndex(cwd: string): Promise<IndexFile | null> {
  try {
    const parsed = JSON.parse(await readFile(indexPath(cwd), "utf8")) as Partial<IndexFile>;
    if (parsed.version !== 1 || !Array.isArray(parsed.entries) || !parsed.builtAt) return null;
    return parsed as IndexFile;
  } catch {
    return null;
  }
}

async function writeIndex(cwd: string, data: IndexFile): Promise<void> {
  const file = indexPath(cwd);
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(tmp, `${JSON.stringify(data)}\n`);
    await rename(tmp, file);
  } catch (err) {
    await unlink(tmp).catch(() => undefined);
    throw err;
  }
}

async function scanRemote(ctx: Context, dir: string): Promise<IndexEntry[]> {
  const files = (await ctx.transport.list(dir, true)).filter(
    (e) => !e.isDir && !ctx.ig.ignores(e.path),
  );
  const paths = new Set(files.map((e) => e.path));
  return files
    .filter((e) => !(e.path.endsWith(BAK_SUFFIX) && paths.has(e.path.slice(0, -BAK_SUFFIX.length))))
    .map((e) => (e.mtime ? { path: e.path, size: e.size, mtime: e.mtime } : { path: e.path, size: e.size }));
}

// dir 지정 시 기존 인덱스의 해당 하위 트리만 교체함 (기존 인덱스 없으면 전체 구축)
export async function buildIndex(ctx: Context, dir = ""): Promise<IndexFile> {
  const prev = dir === "" ? null : await readIndex(ctx.cwd);
  const scope = prev ? dir : "";
  if (prev && scope !== "") {
    const size = await ctx.transport.size(scope);
    if (size !== null) {
      console.error(`원격 인덱스 갱신 중: ${scope} (파일)`);
      const entries = [...prev.entries.filter((e) => e.path !== scope), { path: scope, size }].sort(
        (a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0),
      );
      const data: IndexFile = { version: 1, builtAt: prev.builtAt, entries };
      await writeIndex(ctx.cwd, data);
      console.error(`인덱스 저장됨: ${data.entries.length}개 파일`);
      return data;
    }
  }
  console.error(`원격 인덱스 구축 중: ${scope === "" ? "(전체)" : scope}`);
  const scanned = await scanRemote(ctx, scope);
  const kept = prev ? prev.entries.filter((e) => !underDir(scope, e.path)) : [];
  const data: IndexFile = {
    version: 1,
    builtAt: prev ? prev.builtAt : new Date().toISOString(),
    entries: [...kept, ...scanned].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)),
  };
  await writeIndex(ctx.cwd, data);
  console.error(`인덱스 저장됨: ${data.entries.length}개 파일`);
  return data;
}

export type IndexOp =
  | { op: "remove"; prefix: string }
  | { op: "rename"; from: string; to: string }
  | { op: "add"; entry: IndexEntry };

/** scanRemote 와 같은 규칙: x 가 있으면 x.bak 은 숨김 */
function hideBak(entries: IndexEntry[]): IndexEntry[] {
  const paths = new Set(entries.map((e) => e.path));
  return entries.filter((e) => !(e.path.endsWith(BAK_SUFFIX) && paths.has(e.path.slice(0, -BAK_SUFFIX.length))));
}

/**
 * 원격을 바꾼 명령(rm, mv, cp, touch, tee, sed -i)이 기존 인덱스를 같은 결과로 고쳐 둠
 * 인덱스가 없으면 아무것도 하지 않음 (다음 find/grep 이 새로 구축)
 */
export async function patchIndex(ctx: Pick<Context, "cwd" | "ig">, ops: IndexOp[]): Promise<void> {
  if (ops.length === 0) return;
  const data = await readIndex(ctx.cwd);
  if (!data) return;
  const map = new Map(data.entries.map((e) => [e.path, e] as const));
  for (const o of ops) {
    if (o.op === "remove") {
      for (const p of [...map.keys()]) if (underDir(o.prefix, p)) map.delete(p);
    } else if (o.op === "rename") {
      for (const [p, e] of [...map]) {
        if (!underDir(o.from, p)) continue;
        map.delete(p);
        const to = o.to + p.slice(o.from.length);
        map.set(to, { ...e, path: to });
      }
    } else if (!ctx.ig.ignores(o.entry.path)) {
      map.set(o.entry.path, o.entry);
    }
  }
  const entries = hideBak([...map.values()]).sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  await writeIndex(ctx.cwd, { ...data, entries });
}

export async function loadIndexFile(ctx: Context, opts: { refresh?: boolean } = {}): Promise<IndexFile> {
  const existing = opts.refresh ? null : await readIndex(ctx.cwd);
  return existing ?? buildIndex(ctx);
}

export async function loadIndex(ctx: Context, opts?: { refresh?: boolean }): Promise<IndexEntry[]> {
  return (await loadIndexFile(ctx, opts)).entries;
}

export const indexAgeHours = (data: IndexFile): number =>
  (Date.now() - Date.parse(data.builtAt)) / 3_600_000;

export function warnIfStale(data: IndexFile): void {
  const hours = indexAgeHours(data);
  if (hours > 24) {
    console.error(`경고: 인덱스가 ${Math.floor(hours)}시간 전에 구축됨 (--refresh 권장)`);
  }
}

export const hasGlobChars = (pattern: string): boolean => /[*?]/.test(pattern);

const escapeRegex = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const globCache = new Map<string, RegExp>();

const normalizeGlob = (pattern: string): string =>
  pattern.replace(/\\/g, "/").replace(/^(?:\.?\/)+/, "");

export function globToRegExp(pattern: string): RegExp {
  const p = normalizeGlob(pattern);
  const cached = globCache.get(p);
  if (cached) return cached;
  let src = "";
  for (let i = 0; i < p.length; i++) {
    const c = p[i] as string;
    if (c === "*" && p[i + 1] === "*") {
      const slashAfter = p[i + 2] === "/";
      src += slashAfter ? "(?:.*/)?" : ".*";
      i += slashAfter ? 2 : 1;
    } else if (c === "*") {
      src += "[^/]*";
    } else if (c === "?") {
      src += "[^/]";
    } else {
      src += escapeRegex(c);
    }
  }
  const re = new RegExp(`^${src}$`, "i");
  globCache.set(p, re);
  return re;
}

export function matchGlob(pattern: string, p: string): boolean {
  const target = p.replace(/\\/g, "/");
  const norm = normalizeGlob(pattern);
  const re = globToRegExp(norm);
  if (re.test(target)) return true;
  return !norm.includes("/") && re.test(target.slice(target.lastIndexOf("/") + 1));
}

export function userRegExp(pattern: string, flags: string): RegExp {
  try {
    return new RegExp(pattern, flags);
  } catch (err) {
    throw new Error(`정규식 오류: ${pattern} (${err instanceof Error ? err.message : String(err)})`);
  }
}

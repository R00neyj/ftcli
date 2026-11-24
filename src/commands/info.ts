import type { Command } from "commander";
import { readFile } from "node:fs/promises";
import { posix } from "node:path";
import { intOpt, printJson, type Register } from "../cli.js";
import { configPath } from "../config.js";
import type { GlobalOpts } from "../session.js";
import type { Context } from "../session.js";
import { normalizeRel } from "../state.js";
import { isPermanentReply } from "../transport/errors.js";
import type { RemoteEntry, Transport } from "../transport/types.js";
import path from "node:path";

const message = (err: unknown): string => (err instanceof Error ? err.message : String(err));

const parentOf = (rel: string): string => {
  const dir = posix.dirname(rel);
  return dir === "." ? "" : dir;
};

async function listOrNull(t: Transport, dir: string): Promise<RemoteEntry[] | null> {
  try {
    return await t.list(dir, false);
  } catch (err) {
    if (isPermanentReply(err)) return null;
    throw err;
  }
}

// ---- stat ----

interface StatRow {
  path: string;
  type: "file" | "directory";
  size: number;
  mtime: string | null;
}

async function statCmd(ctx: Context, args: string[], opts: { json?: boolean }): Promise<void> {
  const t = ctx.transport;
  const rows: StatRow[] = [];
  const listings = new Map<string, RemoteEntry[] | null>();
  for (const arg of args) {
    let rel: string;
    try {
      rel = normalizeRel(arg);
    } catch (err) {
      console.error(`실패 ${arg}: ${message(err)}`);
      process.exitCode = 2;
      continue;
    }
    if (rel === "") {
      rows.push({ path: "", type: "directory", size: 0, mtime: null });
      continue;
    }
    const dir = parentOf(rel);
    if (!listings.has(dir)) listings.set(dir, await listOrNull(t, dir));
    const hit = listings.get(dir)?.find((e) => e.path === rel);
    if (!hit) {
      console.error(`실패 ${rel}: 원격에 없음`);
      process.exitCode = 2;
      continue;
    }
    if (hit.isDir) {
      rows.push({ path: rel, type: "directory", size: 0, mtime: null });
      continue;
    }
    const st = await t.stat(rel);
    rows.push({ path: rel, type: "file", size: st?.size ?? hit.size, mtime: st?.mtime ?? hit.mtime ?? null });
  }
  if (opts.json) {
    printJson(rows);
    return;
  }
  for (const r of rows) {
    console.log(`  File: ${r.path === "" ? "." : r.path}`);
    console.log(`  Type: ${r.type === "file" ? "regular file" : "directory"}`);
    if (r.type === "file") console.log(`  Size: ${r.size}`);
    console.log(`Modify: ${r.mtime ?? "-"}`);
  }
}

// ---- pwd ----

/** 접속 없이 config.json 의 remoteRoot 를 출력함 */
async function pwd(cwd: string): Promise<void> {
  let raw: string;
  try {
    raw = await readFile(configPath(cwd), "utf8");
  } catch {
    throw new Error(`설정 파일 없음: ${configPath(cwd)} (ftcli init 먼저 실행)`);
  }
  const cfg = JSON.parse(raw) as { remoteRoot?: string };
  console.log(cfg.remoteRoot ?? "/");
}

// ---- tree ----

interface TreeOpts {
  level?: number;
  dirsOnly?: boolean;
  all?: boolean;
  json?: boolean;
}

interface TreeNode {
  name: string;
  path: string;
  isDir: boolean;
  size: number;
  children?: TreeNode[];
}

async function buildTree(ctx: Context, dir: string, depth: number, opts: TreeOpts): Promise<TreeNode[]> {
  const entries = await ctx.transport.list(dir, false);
  const nodes: TreeNode[] = [];
  const sorted = entries
    .filter((e) => opts.all || !posix.basename(e.path).startsWith("."))
    .filter((e) => !opts.dirsOnly || e.isDir)
    .sort((a, b) => a.path.localeCompare(b.path));
  for (const e of sorted) {
    const node: TreeNode = { name: posix.basename(e.path), path: e.path, isDir: e.isDir, size: e.size };
    if (e.isDir && (opts.level === undefined || depth < opts.level)) {
      node.children = await buildTree(ctx, e.path, depth + 1, opts);
    }
    nodes.push(node);
  }
  return nodes;
}

function render(nodes: TreeNode[], prefix: string, counts: { dirs: number; files: number }): void {
  nodes.forEach((n, i) => {
    const last = i === nodes.length - 1;
    console.log(`${prefix}${last ? "└── " : "├── "}${n.name}${n.isDir ? "/" : ""}`);
    if (n.isDir) counts.dirs++;
    else counts.files++;
    if (n.children) render(n.children, `${prefix}${last ? "    " : "│   "}`, counts);
  });
}

async function tree(ctx: Context, dirArg: string, opts: TreeOpts): Promise<void> {
  const dir = normalizeRel(dirArg);
  const nodes = await buildTree(ctx, dir, 1, opts);
  if (opts.json) {
    printJson(nodes);
    return;
  }
  console.log(dir === "" ? "." : dir);
  const counts = { dirs: 0, files: 0 };
  render(nodes, "", counts);
  console.log(`\n${counts.dirs} directories${opts.dirsOnly ? "" : `, ${counts.files} files`}`);
}

export const registerInfo: Register = (program, run) => {
  program
    .command("stat")
    .description("원격 파일/디렉터리 정보 (종류, 크기, 수정 시각)")
    .argument("<paths...>", "원격 경로")
    .option("--json", "JSON 출력")
    .action((paths: string[], opts: { json?: boolean }, cmd: Command) =>
      run(cmd, (ctx) => statCmd(ctx, paths, opts)),
    );

  program
    .command("pwd")
    .description("원격 기준 경로(config.json 의 remoteRoot) 출력. 접속하지 않음")
    .action((_opts, cmd: Command) =>
      pwd(path.resolve(cmd.optsWithGlobals<GlobalOpts>().cwd ?? process.cwd())),
    );

  program
    .command("tree")
    .description("원격 디렉터리 트리")
    .argument("[dir]", "원격 경로", "")
    .option("-L, --level <n>", "표시할 최대 깊이", intOpt(1, 1000))
    .option("-d, --dirs-only", "디렉터리만 표시")
    .option("-a, --all", ". 으로 시작하는 항목도 표시")
    .option("--json", "JSON 출력")
    .action((dir: string, opts: TreeOpts, cmd: Command) => run(cmd, (ctx) => tree(ctx, dir, opts)));
};

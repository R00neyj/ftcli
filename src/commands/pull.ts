import type { Command } from "commander";
import type { Ignore } from "ignore";
import { constants } from "node:fs";
import { copyFile, lstat, mkdir, rename, rm } from "node:fs/promises";
import path, { posix } from "node:path";
import { jobsOption, printJson, retriesOption, type Register, type ResultRow } from "../cli.js";
import { STATE_DIR } from "../config.js";
import { runPool, type Job } from "../parallel.js";
import { timestamp, type Context } from "../session.js";
import {
  localInfo,
  normalizeRel,
  recordBase,
  remoteSha256,
  remoteVerdict,
  WorkSet,
  type BaseEntry,
  type LocalInfo,
} from "../state.js";
import { downloadVerified } from "../transfer.js";
import { isPermanentReply } from "../transport/errors.js";
import { BAK_SUFFIX, type RemoteEntry, type RemoteStat, type Transport } from "../transport/types.js";

interface PullOpts {
  jobs: number;
  retries: number;
  dryRun?: boolean;
  force?: boolean;
  backup: boolean;
  json?: boolean;
}

interface PullEnv {
  cwd: string;
  ws: WorkSet;
  opts: PullOpts;
  stagingRoot: string;
  backupRoot: string;
  backups: number;
}

type Plan = { kind: "pull"; overwrite: boolean; why: string } | { kind: "skip"; reason: string };

const message = (err: unknown): string => (err instanceof Error ? err.message : String(err));

const CASE_INSENSITIVE_FS = process.platform === "win32" || process.platform === "darwin";
const CASE_CONFLICT = "대소문자만 다른 경로 충돌";

const sameStat = (a: RemoteStat, b: RemoteStat): boolean => a.size === b.size && a.mtime === b.mtime;

const parentOf = (rel: string): string => {
  const dir = posix.dirname(rel);
  return dir === "." ? "" : dir;
};

function expandDir(entries: RemoteEntry[], ig: Ignore): string[] {
  const files = entries.filter((e) => !e.isDir && !ig.ignores(e.path)).map((e) => e.path);
  const all = new Set(files);
  return files.filter((p) => !(p.endsWith(BAK_SUFFIX) && all.has(p.slice(0, -BAK_SUFFIX.length))));
}

async function listOrEmpty(t: Transport, dir: string): Promise<RemoteEntry[]> {
  try {
    return await t.list(dir, false);
  } catch (err) {
    // 550 같은 확정 응답만 "없음" 으로 봄. 연결 오류·일시적 4xx 는 그대로 던짐
    if (!isPermanentReply(err)) throw err;
    return [];
  }
}

// SIZE 는 디렉터리에도 값을 돌려줄 수 있어 부모 목록의 isDir 로 판별함
async function resolveTargets(ctx: Context, args: string[]): Promise<string[]> {
  const t = ctx.transport;
  const listings = new Map<string, RemoteEntry[]>();
  const out = new Set<string>();
  const missing: string[] = [];
  for (const rel of new Set(args.map(normalizeRel))) {
    if (rel !== "") {
      const parent = parentOf(rel);
      let entries = listings.get(parent);
      if (!entries) {
        entries = await listOrEmpty(t, parent);
        listings.set(parent, entries);
      }
      const hit = entries.find((e) => e.path === rel);
      if (!hit) {
        missing.push(rel);
        continue;
      }
      if (!hit.isDir) {
        out.add(rel);
        continue;
      }
    }
    const files = expandDir(await t.list(rel, true), ctx.ig);
    if (files.length === 0) console.error(`대상 파일 없음 (비었거나 전부 제외됨): ${rel || "."}`);
    for (const f of files) out.add(f);
  }
  if (missing.length > 0) throw new Error(`원격에 없음: ${missing.join(", ")}`);
  return [...out].sort();
}

async function localExists(file: string): Promise<boolean> {
  try {
    await lstat(file);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return false;
    throw err;
  }
}

function caseConflicts(targets: string[]): Set<string> {
  const groups = new Map<string, string[]>();
  for (const rel of targets) {
    const key = rel.toLowerCase();
    groups.set(key, [...(groups.get(key) ?? []), rel]);
  }
  return new Set([...groups.values()].filter((g) => g.length > 1).flat());
}

async function backupLocal(dest: string, copy: string): Promise<void> {
  await mkdir(path.dirname(copy), { recursive: true });
  try {
    await copyFile(dest, copy, constants.COPYFILE_EXCL);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") throw new Error(`백업 파일 이미 있음: ${copy}`);
    throw err;
  }
}

async function decide(
  t: Transport,
  rel: string,
  base: BaseEntry | undefined,
  local: LocalInfo | null,
  remote: RemoteStat,
  force: boolean,
): Promise<Plan> {
  if (!local) return { kind: "pull", overwrite: false, why: base ? "로컬 없음" : "신규" };
  if (!base) {
    return force
      ? { kind: "pull", overwrite: true, why: "미추적 로컬 덮어씀" }
      : { kind: "skip", reason: "작업 집합에 없는 로컬 파일 있음 (--force 로 덮어씀)" };
  }
  if (local.sha256 !== base.sha256) {
    return force
      ? { kind: "pull", overwrite: true, why: "로컬 수정분 덮어씀" }
      : { kind: "skip", reason: "로컬 수정됨 (push 하거나 --force 로 덮어씀)" };
  }
  const verdict = remoteVerdict(base, remote);
  if (verdict === "same") return { kind: "skip", reason: "최신" };
  if (verdict === "weak-same" && (await remoteSha256(t, rel)) === base.sha256) {
    return { kind: "skip", reason: "최신 (해시 확인)" };
  }
  return { kind: "pull", overwrite: true, why: "원격 변경됨" };
}

async function downloadOnce(
  t: Transport,
  rel: string,
  staging: string,
  before: RemoteStat,
): Promise<RemoteStat | null> {
  try {
    await downloadVerified(t, rel, staging, before.size);
  } catch (err) {
    if (message(err).startsWith("VERIFY FAILED")) return null;
    throw err;
  }
  return t.stat(rel);
}

async function fetchStable(
  t: Transport,
  rel: string,
  staging: string,
  first: RemoteStat,
  retries: number,
): Promise<RemoteStat> {
  let before = first;
  for (let attempt = 0; ; attempt++) {
    const after = await downloadOnce(t, rel, staging, before);
    if (after && sameStat(before, after)) return before;
    if (attempt >= retries) throw new Error("다운로드 중 원격 변경 감지 - 재시도 소진, 나중에 다시 pull 필요");
    console.error(`재다운로드 ${rel} (${attempt + 1}/${retries}): 다운로드 중 원격 변경 감지`);
    const next = await t.stat(rel);
    if (!next) throw new Error("다운로드 중 원격 삭제됨");
    before = next;
  }
}

function pullJob(env: PullEnv, rel: string, rows: Map<string, ResultRow>): Job {
  const { cwd, ws, opts } = env;
  const dest = path.join(cwd, rel);
  const staging = path.join(env.stagingRoot, rel);
  const prefix = opts.dryRun ? "[dry-run] " : "";
  let label = rel;
  let backedUp = false;

  const execute = async (t: Transport): Promise<ResultRow> => {
    const remote = await t.stat(rel);
    if (!remote) throw new Error("원격에 없음");
    const local = await localInfo(cwd, rel);
    if (!local && (await localExists(dest))) throw new Error("로컬 파일 읽기 불가");
    const plan = await decide(t, rel, ws.get(rel), local, remote, opts.force ?? false);
    if (plan.kind === "skip") {
      label = `${prefix}= ${rel} (${plan.reason})`;
      return { path: rel, action: "skipped", reason: plan.reason };
    }
    const mark = plan.overwrite ? "M" : "+";
    if (opts.dryRun) {
      label = `${prefix}${mark} ${rel} (${plan.why})`;
      return { path: rel, action: "planned", reason: plan.why };
    }
    const stable = await fetchStable(t, rel, staging, remote, opts.retries);
    if (plan.overwrite && opts.backup && !backedUp) {
      await backupLocal(dest, path.join(env.backupRoot, rel));
      backedUp = true;
      env.backups++;
    }
    await mkdir(path.dirname(dest), { recursive: true });
    await rename(staging, dest);
    await recordBase(ws, cwd, rel, stable);
    label = `${mark} ${rel}`;
    return { path: rel, action: "pulled", reason: plan.why };
  };

  return {
    path: rel,
    get label() {
      return label;
    },
    async run(t) {
      try {
        rows.set(rel, await execute(t));
      } catch (err) {
        rows.set(rel, { path: rel, action: "failed", reason: message(err) });
        throw err;
      }
    },
    cleanup: () => rm(staging, { force: true }).then(() => rm(`${staging}.ftcli-part`, { force: true })),
  };
}

async function pull(ctx: Context, args: string[], opts: PullOpts): Promise<void> {
  const targets = await resolveTargets(ctx, args);
  if (targets.length === 0) {
    console.error("pull 대상 없음");
    if (opts.json) printJson([]);
    return;
  }

  const ws = await WorkSet.load(ctx.cwd);
  const env: PullEnv = {
    cwd: ctx.cwd,
    ws,
    opts,
    stagingRoot: path.join(ctx.cwd, STATE_DIR, "staging", `pull-${process.pid}`),
    backupRoot: path.join(ctx.cwd, STATE_DIR, "backups", `${timestamp()}-p${process.pid}`),
    backups: 0,
  };
  const rows = new Map<string, ResultRow>();
  const conflicts = CASE_INSENSITIVE_FS ? caseConflicts(targets) : new Set<string>();
  for (const rel of conflicts) {
    console.error(`실패 ${rel}: ${CASE_CONFLICT}`);
    rows.set(rel, { path: rel, action: "failed", reason: CASE_CONFLICT });
  }
  if (conflicts.size > 0) process.exitCode = 2;
  const jobs = targets.filter((rel) => !conflicts.has(rel)).map((rel) => pullJob(env, rel, rows));
  try {
    if (jobs.length > 0) await runPool(ctx, jobs, { jobs: opts.jobs, retries: opts.retries, log: console.error });
  } finally {
    await rm(env.stagingRoot, { recursive: true, force: true }).catch(() => {});
    if (!opts.dryRun) await ws.save();
  }

  const result = targets.map(
    (rel): ResultRow => rows.get(rel) ?? { path: rel, action: "failed", reason: "처리되지 않음" },
  );
  const count = (action: ResultRow["action"]): number => result.filter((r) => r.action === action).length;
  if (env.backups > 0) console.error(`로컬 백업 ${env.backups}건: ${env.backupRoot}`);
  console.error(
    `${opts.dryRun ? `[dry-run] planned ${count("planned")}` : `pulled ${count("pulled")}`}, skipped ${count("skipped")}, failed ${count("failed")}`,
  );
  if (opts.json) printJson(result);
}

export const registerPull: Register = (program, run) => {
  program
    .command("pull")
    .description("원격 파일을 작업 집합으로 받아옴 (로컬 수정분은 보호)")
    .argument("<paths...>", "원격 경로 (파일 또는 디렉터리)")
    .option("-n, --dry-run", "실행 없이 대상과 skip 이유만 출력")
    .option("--force", "로컬 수정분·미추적 로컬 파일도 덮어씀")
    .option("--no-backup", "덮어쓰는 로컬 파일 백업 안 함")
    .option(...jobsOption)
    .option(...retriesOption)
    .option("--json", "JSON 출력")
    .action((paths: string[], opts: PullOpts, cmd: Command) => run(cmd, (ctx) => pull(ctx, paths, opts)));
};

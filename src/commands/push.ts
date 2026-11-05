import { stat } from "node:fs/promises";
import path, { posix } from "node:path";
import { jobsOption, printJson, retriesOption, type Register, type ResultRow } from "../cli.js";
import { mapPool, type MapOptions } from "../pmap.js";
import { runPool, type Job } from "../parallel.js";
import type { Context } from "../session.js";
import {
  localInfo,
  normalizeRel,
  recordBase,
  remoteSha256,
  remoteVerdict,
  WorkSet,
  type BaseEntry,
  type FileState,
  type LocalInfo,
} from "../state.js";
import type { RemoteStat, Transport } from "../transport/types.js";
import { computeStates, underPrefix } from "./status.js";
import { uploadJob } from "./upload.js";

export interface PushOpts extends MapOptions {
  dryRun?: boolean;
  force?: boolean;
  backup: boolean;
  json?: boolean;
}

interface Plan {
  rel: string;
  base?: BaseEntry;
  note?: string;
}

type Fail = (rel: string, reason: string, quiet?: boolean) => void;

const message = (err: unknown): string => (err instanceof Error ? err.message : String(err));

const byPath = (a: ResultRow, b: ResultRow): number => a.path.localeCompare(b.path);

const REJECT_REASON: Partial<Record<FileState, string>> = {
  conflict: "충돌: 원격도 변경됨 (pull 후 병합 또는 --force)",
  "remote-changed": "원격 변경됨, 로컬 수정 없음 (pull 필요 또는 --force)",
  "remote-deleted": "원격에서 삭제됨 (--force 로 재업로드)",
};

const SKIP_REASON: Partial<Record<FileState, string>> = {
  clean: "변경 없음",
  "local-missing": "로컬 파일 없음",
  "remote-deleted": "원격에서 삭제됨 — 로컬 변경은 명시 경로 + --force 로 복구 가능",
};

async function localKind(cwd: string, rel: string): Promise<"file" | "dir" | null> {
  try {
    const st = await stat(path.join(cwd, rel));
    return st.isFile() ? "file" : st.isDirectory() ? "dir" : null;
  } catch {
    return null;
  }
}

const parentOf = (rel: string): string => (posix.dirname(rel) === "." ? "" : posix.dirname(rel));

async function guard(
  t: Transport,
  rel: string,
  base: BaseEntry | undefined,
  remote: RemoteStat | null,
): Promise<void> {
  if (!base) {
    if (remote) throw new Error("CONFLICT: 원격에 이미 존재함 (작업 집합에 없음, --force 로 덮어씀)");
    return;
  }
  const verdict = remoteVerdict(base, remote);
  if (verdict === "same") return;
  if (verdict === "weak-same" && (await remoteSha256(t, rel)) === base.sha256) return;
  const what = verdict === "deleted" ? "원격에서 삭제됨" : "원격 변경됨";
  throw new Error(`CONFLICT: ${what} (pull 후 재시도 또는 --force)`);
}

function pushJob(
  ctx: Context,
  ws: WorkSet,
  plan: Plan,
  opts: PushOpts,
  outcome: Map<string, string | null>,
): Job {
  const { rel, base } = plan;
  let inner: Job | undefined;
  let uploaded: LocalInfo | undefined;
  let started = false;

  const prepare = async (t: Transport): Promise<Job> => {
    const remote = await t.stat(rel);
    if (!opts.force) await guard(t, rel, base, remote);
    const dir = parentOf(rel);
    if (!remote && dir !== "") await t.mkdirs([dir]);
    const local = await localInfo(ctx.cwd, rel);
    if (!local) throw new Error("로컬 파일 없음");
    uploaded = local;
    return uploadJob(ctx, rel, remote ? "modified" : "localOnly", local.size, opts.backup);
  };

  return {
    path: rel,
    get label() {
      return inner?.label ?? `${base ? "M" : "+"} ${rel}`;
    },
    async run(t) {
      try {
        const job = started && inner ? inner : await prepare(t);
        inner = job;
        started = true;
        await job.run(t);
        const fresh = await t.stat(rel);
        if (!fresh) throw new Error("업로드 후 원격 파일 없음");
        await recordBase(ws, ctx.cwd, rel, fresh, uploaded);
        outcome.set(rel, null);
        const now = await localInfo(ctx.cwd, rel);
        if (now?.sha256 !== uploaded?.sha256) console.error(`경고: 업로드 중 로컬 변경됨 ${rel} — status 로 확인`);
      } catch (err) {
        outcome.set(rel, message(err));
        throw err;
      }
    },
    async abandon(t) {
      if (started) await inner?.abandon?.(t);
    },
  };
}

async function dryRun(
  ctx: Context,
  plans: Plan[],
  opts: PushOpts,
  rows: ResultRow[],
  fail: Fail,
): Promise<void> {
  const fresh = plans.filter((p) => !p.base);
  const remotes = fresh.length > 0 ? await mapPool(ctx, fresh, opts, (t, p) => t.stat(p.rel)) : [];
  const remoteOf = new Map(fresh.map((p, i) => [p.rel, remotes[i]] as const));
  for (const plan of plans) {
    let label = `${plan.base ? "M" : "+"} ${plan.rel}`;
    const r = remoteOf.get(plan.rel);
    if (r && !r.ok) {
      fail(plan.rel, `원격 조회 실패: ${message(r.error)}`);
      continue;
    }
    if (r?.value) {
      if (!opts.force) {
        fail(plan.rel, "원격에 이미 존재함 (작업 집합에 없음, --force 로 덮어씀)");
        continue;
      }
      label = `M ${plan.rel} (--force: 원격 덮어씀)`;
    } else if (plan.note) {
      label = `${label} (${plan.note})`;
    }
    rows.push({ path: plan.rel, action: "planned", reason: "dry-run" });
    if (!opts.json) console.log(`[dry-run] ${label}`);
  }
  if (opts.json) printJson(rows.sort(byPath));
  else if (rows.every((r) => r.action !== "planned")) console.error("업로드 대상 없음");
}

async function push(ctx: Context, files: string[], opts: PushOpts): Promise<void> {
  const ws = await WorkSet.load(ctx.cwd);
  const rows: ResultRow[] = [];
  const explicit = files.length > 0;
  const fail: Fail = (rel, reason, quiet = false) => {
    rows.push({ path: rel, action: "failed", reason });
    if (!quiet) console.error(`거부 ${rel}: ${reason}`);
    process.exitCode = 2;
  };
  const skip = (rel: string, reason: string): void => {
    rows.push({ path: rel, action: "skipped", reason });
    console.error(`건너뜀 ${rel}: ${reason}`);
  };

  const tracked = new Set<string>();
  const untracked = new Set<string>();
  if (!explicit) for (const rel of ws.paths()) tracked.add(rel);
  for (const arg of files) {
    const rel = normalizeRel(arg);
    if (ws.get(rel)) {
      tracked.add(rel);
      continue;
    }
    const under = ws.paths().filter((p) => underPrefix(p, rel) && !ctx.ig.ignores(p));
    if (under.length > 0) {
      for (const p of under) tracked.add(p);
      continue;
    }
    const kind = rel === "" ? "dir" : await localKind(ctx.cwd, rel);
    if (kind === "file") untracked.add(rel);
    else if (kind === "dir") fail(rel || ".", "작업 집합에 해당 경로 파일 없음 (신규 파일은 파일 경로로 지정)");
    else fail(rel, "로컬 파일 없음");
  }

  const plans: Plan[] = [];
  const states = tracked.size > 0 ? await computeStates(ctx, ws, [...tracked], opts) : new Map<string, FileState>();
  for (const rel of tracked) {
    const state = states.get(rel);
    const base = ws.get(rel);
    if (!state || !base) {
      fail(rel, "원격 조회 실패", true);
      continue;
    }
    if (state === "local-modified") {
      plans.push({ rel, base });
      continue;
    }
    const reject = REJECT_REASON[state];
    if (reject && (explicit || state === "conflict")) {
      if (opts.force) plans.push({ rel, base, note: `--force: ${state}` });
      else fail(rel, reject);
    } else if (explicit || state === "remote-deleted") {
      skip(rel, SKIP_REASON[state] ?? state);
    }
  }
  for (const rel of untracked) plans.push({ rel, note: "신규" });

  if (opts.dryRun) {
    await dryRun(ctx, plans, opts, rows, fail);
    return;
  }

  if (plans.length === 0) {
    console.error("업로드 대상 없음");
    if (opts.json) printJson(rows.sort(byPath));
    return;
  }

  const outcome = new Map<string, string | null>();
  const jobs = plans.map((plan) => pushJob(ctx, ws, plan, opts, outcome));
  let poolError: unknown;
  try {
    await runPool(ctx, jobs, { jobs: opts.jobs, retries: opts.retries, log: console.error });
  } catch (err) {
    poolError = err;
  } finally {
    await ws.save();
  }

  for (const { rel } of plans) {
    const result = outcome.get(rel);
    if (result === null) rows.push({ path: rel, action: "pushed" });
    else rows.push({ path: rel, action: "failed", reason: result ?? "처리되지 않음" });
  }
  if (opts.json) printJson(rows.sort(byPath));
  if (poolError) throw poolError;
}

export const registerPush: Register = (program, run) => {
  program
    .command("push")
    .description("작업 집합의 로컬 수정 파일 업로드 (원격 변경 시 거부, 덮어쓰기 전 원격 .bak 생성)")
    .argument("[files...]", "대상 경로 (생략 시 작업 집합의 로컬 수정 파일 전체)")
    .option("-n, --dry-run", "실행 없이 계획만 출력")
    .option("--force", "원격 변경/충돌/삭제 무시하고 덮어씀")
    .option("--no-backup", "원격 .bak 생성 안 함")
    .option("--json", "JSON 출력")
    .option(...jobsOption)
    .option(...retriesOption)
    .action((files: string[], opts: PushOpts, cmd) => run(cmd, (ctx) => push(ctx, files, opts)));
};

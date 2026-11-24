import { FTPError } from "basic-ftp";
import type { Command } from "commander";
import { posix } from "node:path";
import { jobsOption, printJson, retriesOption, type Register, type ResultRow } from "../cli.js";
import { runPool, type Job } from "../parallel.js";
import type { Context } from "../session.js";
import { normalizeRel, remoteSha256, remoteVerdict, WorkSet, type BaseEntry } from "../state.js";
import { BAK_SUFFIX, type RemoteEntry, type Transport } from "../transport/types.js";
import { underPrefix } from "./status.js";

interface RmOpts {
  recursive?: boolean;
  dryRun?: boolean;
  force?: boolean;
  backup: boolean;
  jobs: number;
  retries: number;
  json?: boolean;
}

interface Target {
  rel: string;
  isDir: boolean;
  bakKind: "file" | "dir" | null;
  tracked: string[];
}

const CONNECTION_CODES = new Set([421, 425, 426, 530]);

const message = (err: unknown): string => (err instanceof Error ? err.message : String(err));

const byPath = (a: ResultRow, b: ResultRow): number => a.path.localeCompare(b.path);

const parentOf = (rel: string): string => {
  const dir = posix.dirname(rel);
  return dir === "." ? "" : dir;
};

async function listOrEmpty(t: Transport, dir: string): Promise<RemoteEntry[]> {
  try {
    return await t.list(dir, false);
  } catch (err) {
    if (!(err instanceof FTPError) || CONNECTION_CODES.has(err.code)) throw err;
    return [];
  }
}

async function findEntry(t: Transport, rel: string): Promise<RemoteEntry | undefined> {
  const entries = await listOrEmpty(t, parentOf(rel));
  return entries.find((e) => e.path === rel);
}

async function isUnchanged(t: Transport, rel: string, base: BaseEntry): Promise<boolean> {
  const remote = await t.stat(rel);
  const verdict = remoteVerdict(base, remote);
  if (verdict === "same" || verdict === "deleted") return true;
  if (verdict === "weak-same") return (await remoteSha256(t, rel)) === base.sha256;
  return false;
}

async function checkGuard(t: Transport, ws: WorkSet, target: Target): Promise<string | null> {
  if (!target.isDir) {
    const base = ws.get(target.rel);
    if (!base) return null;
    return (await isUnchanged(t, target.rel, base))
      ? null
      : "충돌: 원격 변경됨 (--force 로 강제 삭제)";
  }
  const changed: string[] = [];
  for (const rel of target.tracked) {
    const base = ws.get(rel);
    if (!base) continue;
    if (!(await isUnchanged(t, rel, base))) changed.push(rel);
  }
  if (changed.length === 0) return null;
  const sample = changed.slice(0, 3).join(", ") + (changed.length > 3 ? ` 외 ${changed.length - 3}건` : "");
  return `충돌: 하위 원격 변경됨 (${sample}) (--force 로 강제 삭제)`;
}

async function moveToBak(t: Transport, target: Target, attempted: boolean): Promise<void> {
  const { rel } = target;
  const bak = `${rel}${BAK_SUFFIX}`;
  let bakKind = target.bakKind;

  if (attempted) {
    const parent = await listOrEmpty(t, parentOf(rel));
    const relEntry = parent.find((e) => e.path === rel);
    const bakEntry = parent.find((e) => e.path === bak);
    if (!relEntry && bakEntry) return;
    if (!relEntry) throw new Error("원격에 없음");
    bakKind = bakEntry ? (bakEntry.isDir ? "dir" : "file") : null;
  }

  if (bakKind === "dir") await t.removeDir(bak);
  else if (bakKind === "file") await t.remove(bak, true);

  try {
    await t.rename(rel, bak);
  } catch (err) {
    const after = await listOrEmpty(t, parentOf(rel));
    const replyLost = !after.some((e) => e.path === rel) && after.some((e) => e.path === bak);
    if (!replyLost) throw err;
  }
}

async function removePermanently(
  t: Transport,
  target: Target,
  attempted: boolean,
  force: boolean,
): Promise<void> {
  if (target.isDir) {
    if (attempted && !(await findEntry(t, target.rel))) return;
    await t.removeDir(target.rel);
    return;
  }
  await t.remove(target.rel, attempted || force);
}

function rmJob(
  ws: WorkSet,
  target: Target,
  opts: RmOpts,
  rows: Map<string, ResultRow>,
  markDirty: () => void,
): Job {
  const { rel, isDir, tracked } = target;
  const suffix = isDir ? "/" : "";
  const bak = `${rel}${BAK_SUFFIX}`;
  const actionNote = opts.backup ? `${bak}${suffix} 으로 이동` : "완전 삭제";
  let label = `- ${rel}${suffix}`;
  let attempted = false;

  const execute = async (t: Transport): Promise<ResultRow> => {
    if (!opts.force) {
      const conflict = await checkGuard(t, ws, target);
      if (conflict) throw new Error(conflict);
    }

    if (opts.dryRun) {
      label = `[dry-run] - ${rel}${suffix} (${actionNote})`;
      return { path: rel, action: "planned", reason: actionNote };
    }

    const wasAttempted = attempted;
    attempted = true;
    if (opts.backup) await moveToBak(t, target, wasAttempted);
    else await removePermanently(t, target, wasAttempted, Boolean(opts.force));

    if (tracked.length > 0) {
      for (const p of tracked) ws.delete(p);
      markDirty();
    }

    label = opts.backup ? `- ${rel}${suffix} -> ${bak}${suffix}` : `- ${rel}${suffix} (삭제)`;
    return { path: rel, action: "removed", reason: actionNote };
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
  };
}

async function resolveTargets(
  ctx: Context,
  ws: WorkSet,
  args: string[],
  opts: RmOpts,
  rows: Map<string, ResultRow>,
  markDirty: () => void,
): Promise<Target[]> {
  const listings = new Map<string, RemoteEntry[]>();
  const getListing = async (dir: string): Promise<RemoteEntry[]> => {
    let entries = listings.get(dir);
    if (!entries) {
      entries = await listOrEmpty(ctx.transport, dir);
      listings.set(dir, entries);
    }
    return entries;
  };

  const fail = (rel: string, reason: string): void => {
    rows.set(rel, { path: rel, action: "failed", reason });
    console.error(`거부 ${rel}: ${reason}`);
    process.exitCode = 2;
  };
  const skip = (rel: string, reason: string): void => {
    rows.set(rel, { path: rel, action: "skipped", reason });
    console.error(`건너뜀 ${rel}: ${reason}`);
  };

  const unique: string[] = [];
  const seen = new Set<string>();
  for (const arg of args) {
    let rel: string;
    try {
      rel = normalizeRel(arg);
    } catch (err) {
      fail(arg, message(err));
      continue;
    }
    if (rel === "") {
      fail(arg, "루트 경로는 삭제할 수 없음");
      continue;
    }
    if (seen.has(rel)) continue;
    seen.add(rel);
    unique.push(rel);
  }

  const found: Target[] = [];
  for (const rel of unique) {
    if (opts.backup && rel.endsWith(BAK_SUFFIX)) {
      fail(rel, "이미 .bak 백업 파일임 (완전 삭제하려면 --no-backup 사용)");
      continue;
    }
    const entries = await getListing(parentOf(rel));
    const hit = entries.find((e) => e.path === rel);
    if (!hit) {
      if (opts.force) {
        if (!opts.dryRun) {
          const stale = opts.recursive
            ? ws.paths().filter((p) => underPrefix(p, rel))
            : ws.get(rel)
              ? [rel]
              : [];
          if (stale.length > 0) {
            for (const p of stale) ws.delete(p);
            markDirty();
          }
        }
        skip(rel, "원격에 없음");
      } else {
        fail(rel, "원격에 없음");
      }
      continue;
    }
    if (hit.isDir && !opts.recursive) {
      fail(rel, "디렉터리임 (-r 옵션 필요)");
      continue;
    }
    const bakHit = entries.find((e) => e.path === `${rel}${BAK_SUFFIX}`);
    const bakKind = bakHit ? (bakHit.isDir ? "dir" : "file") : null;
    const tracked = hit.isDir
      ? ws.paths().filter((p) => underPrefix(p, rel))
      : ws.get(rel)
        ? [rel]
        : [];
    found.push({ rel, isDir: hit.isDir, bakKind, tracked });
  }

  // 상위 디렉터리가 함께 삭제 대상이면 하위 경로는 중복 실행을 막기 위해 제외
  const dirs = found.filter((t) => t.isDir).map((t) => t.rel);
  const targets: Target[] = [];
  for (const t of found) {
    const coveredBy = dirs.find((d) => d !== t.rel && t.rel.startsWith(`${d}/`));
    if (coveredBy) {
      skip(t.rel, `상위 디렉터리(${coveredBy}) 삭제에 포함됨`);
      continue;
    }
    targets.push(t);
  }
  return targets;
}

async function rmCmd(ctx: Context, args: string[], opts: RmOpts): Promise<void> {
  const ws = await WorkSet.load(ctx.cwd);
  const rows = new Map<string, ResultRow>();
  let targets: Target[] = [];
  let wsDirty = false;
  const markDirty = (): void => {
    wsDirty = true;
  };
  let poolError: unknown;

  try {
    targets = await resolveTargets(ctx, ws, args, opts, rows, markDirty);
    const poolTargets: Target[] = [];
    for (const t of targets) {
      if (opts.dryRun && (opts.force || t.tracked.length === 0)) {
        const suffix = t.isDir ? "/" : "";
        const actionNote = opts.backup ? `${t.rel}${BAK_SUFFIX}${suffix} 으로 이동` : "완전 삭제";
        console.error(`[dry-run] - ${t.rel}${suffix} (${actionNote})`);
        rows.set(t.rel, { path: t.rel, action: "planned", reason: actionNote });
      } else {
        poolTargets.push(t);
      }
    }
    const jobs = poolTargets.map((t) => rmJob(ws, t, opts, rows, markDirty));
    if (jobs.length > 0) {
      await runPool(ctx, jobs, { jobs: opts.jobs, retries: opts.retries, log: console.error });
    }
  } catch (err) {
    poolError = err;
  } finally {
    if (!opts.dryRun && wsDirty) await ws.save();
  }

  for (const t of targets) {
    if (!rows.has(t.rel)) {
      rows.set(t.rel, { path: t.rel, action: "failed", reason: "처리되지 않음" });
    }
  }

  const result = [...rows.values()].sort(byPath);
  const count = (action: ResultRow["action"]): number =>
    result.filter((r) => r.action === action).length;
  console.error(
    `${opts.dryRun ? `[dry-run] planned ${count("planned")}` : `removed ${count("removed")}`}, skipped ${count("skipped")}, failed ${count("failed")}`,
  );
  if (opts.json) printJson(result);
  if (poolError) throw poolError;
}

export const registerRm: Register = (program, run) => {
  program
    .command("rm")
    .alias("del")
    .description("원격 파일/디렉터리 삭제 (기본: <경로>.bak 으로 이동, --no-backup 시 완전 삭제)")
    .argument("<paths...>", "삭제할 원격 경로")
    .option("-r, --recursive", "디렉터리 삭제 허용")
    .option("-n, --dry-run", "실행 없이 계획만 출력")
    .option("-f, --force", "원격 변경 충돌·미존재 경로 무시")
    .option("--no-backup", "원격 .bak 생성 없이 완전 삭제")
    .option(...jobsOption)
    .option(...retriesOption)
    .option("--json", "JSON 출력")
    .action((paths: string[], opts: RmOpts, cmd: Command) => run(cmd, (ctx) => rmCmd(ctx, paths, opts)));
};

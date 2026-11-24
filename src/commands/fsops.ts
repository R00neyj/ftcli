import { FTPError } from "basic-ftp";
import type { Command } from "commander";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path, { posix } from "node:path";
import { Readable } from "node:stream";
import { jobsOption, printJson, retriesOption, type Register, type ResultRow } from "../cli.js";
import { patchIndex, underDir, type IndexOp } from "../indexer.js";
import { runPool, type Job } from "../parallel.js";
import {
  findEntry,
  hasUnpushedEdits,
  message,
  moveToBak,
  once,
  parentOf,
} from "../remote-ops.js";
import type { Context } from "../session.js";
import { normalizeRel, WorkSet } from "../state.js";
import { downloadVerified, removePart } from "../transfer.js";
import { BAK_SUFFIX, type RemoteEntry } from "../transport/types.js";
import { underPrefix } from "./status.js";
import { uploadJob } from "./upload.js";

/** 결과 행을 모으고 실패 시 exitCode 2 를 설정하는 공통 기록기 */
class Report {
  readonly rows: ResultRow[] = [];

  ok(row: ResultRow, label: string): void {
    this.rows.push(row);
    console.error(label);
  }

  fail(rel: string, reason: string): void {
    this.rows.push({ path: rel, action: "failed", reason });
    console.error(`실패 ${rel}: ${reason}`);
    process.exitCode = 2;
  }

  skip(rel: string, reason: string): void {
    this.rows.push({ path: rel, action: "skipped", reason });
    console.error(`건너뜀 ${rel}: ${reason}`);
  }

  print(json?: boolean): void {
    if (json) printJson(this.rows);
  }
}

function rel(report: Report, arg: string, allowRoot = false): string | null {
  try {
    const r = normalizeRel(arg);
    if (r === "" && !allowRoot) {
      report.fail(arg, "루트 경로는 대상이 될 수 없음");
      return null;
    }
    return r;
  } catch (err) {
    report.fail(arg, message(err));
    return null;
  }
}

async function parentExists(ctx: Context, p: string): Promise<boolean> {
  const parent = parentOf(p);
  return parent === "" || Boolean((await findEntry(ctx.transport, parent))?.isDir);
}

const join = (dir: string, name: string): string => (dir === "" ? name : `${dir}/${name}`);

// ---- mkdir ----

async function mkdirCmd(ctx: Context, args: string[], opts: { parents?: boolean; json?: boolean }): Promise<void> {
  const report = new Report();
  for (const arg of args) {
    const p = rel(report, arg);
    if (p === null) continue;
    try {
      const existing = await findEntry(ctx.transport, p);
      if (existing) {
        if (opts.parents && existing.isDir) report.skip(p, "이미 있음");
        else report.fail(p, "이미 존재함");
        continue;
      }
      if (opts.parents) await once(ctx, (t) => t.mkdirs([p]));
      else {
        if (!(await parentExists(ctx, p))) {
          report.fail(p, "상위 디렉터리 없음 (-p 사용)");
          continue;
        }
        await once(ctx, (t) => t.mkdir(p));
      }
      report.ok({ path: p, action: "created" }, `mkdir ${p}/`);
    } catch (err) {
      report.fail(p, message(err));
    }
  }
  report.print(opts.json);
}

// ---- mv ----

interface MvOpts {
  dryRun?: boolean;
  force?: boolean;
  backup: boolean;
  json?: boolean;
}

async function dirtyTracked(ctx: Context, ws: WorkSet, prefix: string): Promise<string[]> {
  const dirty: string[] = [];
  for (const p of ws.paths().filter((x) => underPrefix(x, prefix))) {
    if (await hasUnpushedEdits(ctx, ws, p)) dirty.push(p);
  }
  return dirty;
}

const dirtyReason = (paths: string[]): string =>
  `작업 집합에 push 하지 않은 로컬 수정 있음: ${paths.slice(0, 3).join(", ")}${paths.length > 3 ? ` 외 ${paths.length - 3}건` : ""} (push 후 재시도 또는 -f)`;

async function mvCmd(ctx: Context, args: string[], opts: MvOpts): Promise<void> {
  const report = new Report();
  if (args.length < 2) throw new Error("원본과 대상이 필요함: mv <원본...> <대상>");
  const ws = await WorkSet.load(ctx.cwd);
  const dst = rel(report, args.at(-1) as string, true);
  if (dst === null) return report.print(opts.json);
  const dstEntry = await findEntry(ctx.transport, dst);
  const srcs = args.slice(0, -1);
  if (srcs.length > 1 && !dstEntry?.isDir) throw new Error(`대상이 디렉터리가 아님: ${dst || "."}`);
  const indexOps: IndexOp[] = [];
  let wsDirty = false;

  try {
    for (const arg of srcs) {
      const src = rel(report, arg);
      if (src === null) continue;
      try {
        const srcEntry = await findEntry(ctx.transport, src);
        if (!srcEntry) {
          report.fail(src, "원격에 없음");
          continue;
        }
        const target = dstEntry?.isDir ? join(dst, posix.basename(src)) : dst;
        if (target === src) {
          report.skip(src, "원본과 대상이 같음");
          continue;
        }
        if (srcEntry.isDir && underDir(src, target)) {
          report.fail(src, `자기 하위 경로로 옮길 수 없음: ${target}`);
          continue;
        }
        const targetEntry = target === dst ? dstEntry : await findEntry(ctx.transport, target);
        if (!targetEntry && !(await parentExists(ctx, target))) {
          report.fail(src, `대상의 상위 디렉터리 없음: ${parentOf(target)}`);
          continue;
        }
        if (targetEntry?.isDir) {
          report.fail(src, `대상에 같은 이름의 디렉터리가 있음: ${target}`);
          continue;
        }
        if (targetEntry && srcEntry.isDir) {
          report.fail(src, `디렉터리를 파일 위로 옮길 수 없음: ${target}`);
          continue;
        }
        if (!opts.force) {
          const dirty = [...(await dirtyTracked(ctx, ws, src)), ...(targetEntry ? await dirtyTracked(ctx, ws, target) : [])];
          if (dirty.length > 0) {
            report.fail(src, dirtyReason(dirty));
            continue;
          }
        }
        const overwrite = targetEntry ? (opts.backup ? ` (기존 ${target} 은 ${target}${BAK_SUFFIX} 로)` : " (기존 파일 덮어씀)") : "";
        if (opts.dryRun) {
          report.ok({ path: src, action: "planned", reason: `-> ${target}` }, `[dry-run] mv ${src} -> ${target}${overwrite}`);
          continue;
        }
        await once(ctx, async (t) => {
          if (targetEntry) {
            if (opts.backup) await moveToBak(t, target);
            else await t.remove(target, true);
          }
          try {
            await t.rename(src, target);
          } catch (err) {
            // 대상만 .bak 으로 옮겨지고 이동은 실패한 경우 대상을 되돌림
            if (targetEntry && opts.backup) await t.rename(`${target}${BAK_SUFFIX}`, target).catch(() => {});
            throw err;
          }
        });
        const tracked = ws.paths().filter((p) => underPrefix(p, src));
        for (const p of tracked) ws.delete(p);
        if (tracked.length > 0) {
          wsDirty = true;
          console.error(`작업 집합에서 제거됨 ${tracked.length}건 (새 경로는 pull 로 다시 받음)`);
        }
        if (targetEntry) indexOps.push({ op: "remove", prefix: target });
        indexOps.push({ op: "rename", from: src, to: target });
        report.ok({ path: src, action: "moved", reason: `-> ${target}` }, `mv ${src} -> ${target}${overwrite}`);
      } catch (err) {
        report.fail(src, message(err));
      }
    }
  } finally {
    if (wsDirty) await ws.save();
    await patchIndex(ctx, indexOps).catch((err) => console.error(`인덱스 갱신 실패 (find --refresh 권장): ${message(err)}`));
  }
  report.print(opts.json);
}

// ---- cp ----

interface CpOpts {
  recursive?: boolean;
  dryRun?: boolean;
  force?: boolean;
  backup: boolean;
  jobs: number;
  retries: number;
  json?: boolean;
}

interface CopyPlan {
  from: string;
  to: string;
  size: number;
  overwrite: boolean;
}

async function cpCmd(ctx: Context, args: string[], opts: CpOpts): Promise<void> {
  const report = new Report();
  if (args.length < 2) throw new Error("원본과 대상이 필요함: cp <원본...> <대상>");
  const ws = await WorkSet.load(ctx.cwd);
  const t0 = ctx.transport;
  const dst = rel(report, args.at(-1) as string, true);
  if (dst === null) return report.print(opts.json);
  const dstEntry = await findEntry(t0, dst);
  const srcs = args.slice(0, -1);
  if (srcs.length > 1 && !dstEntry?.isDir) throw new Error(`대상이 디렉터리가 아님: ${dst || "."}`);

  const plans: CopyPlan[] = [];
  const dirs = new Set<string>();
  for (const arg of srcs) {
    const src = rel(report, arg);
    if (src === null) continue;
    try {
      const srcEntry = await findEntry(t0, src);
      if (!srcEntry) {
        report.fail(src, "원격에 없음");
        continue;
      }
      const target = dstEntry?.isDir ? join(dst, posix.basename(src)) : dst;
      if (target === src) {
        report.fail(src, "원본과 대상이 같음");
        continue;
      }
      const targetEntry = target === dst ? dstEntry : await findEntry(t0, target);
      if (!targetEntry && !(await parentExists(ctx, target))) {
        report.fail(src, `대상의 상위 디렉터리 없음: ${parentOf(target)}`);
        continue;
      }
      if (!srcEntry.isDir) {
        if (targetEntry?.isDir) {
          report.fail(src, `대상에 같은 이름의 디렉터리가 있음: ${target}`);
          continue;
        }
        plans.push({ from: src, to: target, size: srcEntry.size, overwrite: Boolean(targetEntry) });
        continue;
      }
      if (!opts.recursive) {
        report.fail(src, "디렉터리임 (-r 옵션 필요)");
        continue;
      }
      if (underDir(src, target)) {
        report.fail(src, `자기 하위 경로로 복사할 수 없음: ${target}`);
        continue;
      }
      if (targetEntry && !targetEntry.isDir) {
        report.fail(src, `대상이 파일임: ${target}`);
        continue;
      }
      const existing = new Map<string, RemoteEntry>();
      if (targetEntry) for (const e of await t0.list(target, true)) existing.set(e.path, e);
      dirs.add(target);
      for (const e of await t0.list(src, true)) {
        const to = target + e.path.slice(src.length);
        if (e.isDir) {
          if (existing.get(to)?.isDir === false) report.fail(e.path, `대상이 파일임: ${to}`);
          else dirs.add(to);
          continue;
        }
        const ex = existing.get(to);
        if (ex?.isDir) {
          report.fail(e.path, `대상에 같은 이름의 디렉터리가 있음: ${to}`);
          continue;
        }
        plans.push({ from: e.path, to, size: e.size, overwrite: Boolean(ex) });
      }
    } catch (err) {
      report.fail(src, message(err));
    }
  }

  const runnable: CopyPlan[] = [];
  for (const p of plans) {
    if (p.overwrite && !opts.force && (await hasUnpushedEdits(ctx, ws, p.to))) {
      report.fail(p.from, dirtyReason([p.to]));
      continue;
    }
    runnable.push(p);
  }

  if (opts.dryRun) {
    for (const d of [...dirs].sort()) {
      if (!(await findEntry(t0, d))) console.error(`[dry-run] mkdir ${d}/`);
    }
    for (const p of runnable) {
      const note = p.overwrite ? (opts.backup ? ` (기존 파일은 ${p.to}${BAK_SUFFIX} 로)` : " (덮어씀)") : "";
      report.ok({ path: p.from, action: "planned", reason: `-> ${p.to}` }, `[dry-run] cp ${p.from} -> ${p.to}${note}`);
    }
    report.print(opts.json);
    return;
  }

  const tmp = await mkdtemp(path.join(tmpdir(), "ftcli-cp-"));
  const indexOps: IndexOp[] = [];
  let poolError: unknown;
  try {
    const newDirs = [...dirs].filter((d) => d !== "");
    if (newDirs.length > 0) await t0.mkdirs(newDirs);
    const done = new Set<CopyPlan>();
    const jobs: Job[] = runnable.map((p, i) => {
      const local = path.join(tmp, String(i));
      let fetched = false;
      const inner = uploadJob(ctx, p.to, p.overwrite ? "modified" : "localOnly", p.size, opts.backup, local);
      return {
        path: p.from,
        label: `cp ${p.from} -> ${p.to}`,
        async run(t) {
          if (!fetched) {
            await downloadVerified(t, p.from, local, p.size);
            fetched = true;
          }
          await inner.run(t);
          done.add(p);
          await rm(local, { force: true });
        },
        abandon: (t) => (inner.abandon ? inner.abandon(t) : Promise.resolve()),
        cleanup: () => removePart(local),
      };
    });
    if (jobs.length > 0) {
      try {
        await runPool(ctx, jobs, { jobs: opts.jobs, retries: opts.retries, log: console.error, summary: false });
      } catch (err) {
        poolError = err;
      }
    }
    for (const p of runnable) {
      if (done.has(p)) {
        report.rows.push({ path: p.from, action: "copied", reason: `-> ${p.to}` });
        indexOps.push({ op: "add", entry: { path: p.to, size: p.size } });
      } else {
        report.rows.push({ path: p.from, action: "failed", reason: "복사 실패" });
        process.exitCode = 2;
      }
    }
  } finally {
    await rm(tmp, { recursive: true, force: true });
    await patchIndex(ctx, indexOps).catch((err) => console.error(`인덱스 갱신 실패 (find --refresh 권장): ${message(err)}`));
  }
  report.print(opts.json);
  if (poolError) throw poolError;
}

// ---- touch ----

async function touchCmd(ctx: Context, args: string[], opts: { noCreate?: boolean; json?: boolean }): Promise<void> {
  const report = new Report();
  const indexOps: IndexOp[] = [];
  try {
    for (const arg of args) {
      const p = rel(report, arg);
      if (p === null) continue;
      try {
        const existing = await findEntry(ctx.transport, p);
        if (existing) {
          // MFMT 로 수정 시각을 바꾸면 작업 집합 status 가 R(원격 변경)로 바뀌므로 하지 않음
          report.skip(p, existing.isDir ? "디렉터리임" : "이미 존재함 (수정 시각은 바꾸지 않음)");
          continue;
        }
        if (opts.noCreate) {
          report.skip(p, "없음 (-c)");
          continue;
        }
        if (!(await parentExists(ctx, p))) {
          report.fail(p, `상위 디렉터리 없음: ${parentOf(p)}`);
          continue;
        }
        await once(ctx, (t) => t.uploadFromStream(Readable.from([Buffer.alloc(0)], { objectMode: false }), p));
        indexOps.push({ op: "add", entry: { path: p, size: 0 } });
        report.ok({ path: p, action: "created" }, `touch ${p}`);
      } catch (err) {
        report.fail(p, message(err));
      }
    }
  } finally {
    await patchIndex(ctx, indexOps).catch((err) => console.error(`인덱스 갱신 실패 (find --refresh 권장): ${message(err)}`));
  }
  report.print(opts.json);
}

// ---- chmod ----

const UNSUPPORTED = new Set([500, 502, 504]);

async function chmodCmd(
  ctx: Context,
  mode: string,
  args: string[],
  opts: { recursive?: boolean; json?: boolean },
): Promise<void> {
  if (!/^[0-7]{3,4}$/.test(mode)) throw new Error(`숫자 모드만 지원함 (예: 644, 755): ${mode}`);
  const report = new Report();
  for (const arg of args) {
    const p = rel(report, arg, true);
    if (p === null) continue;
    try {
      const entry = await findEntry(ctx.transport, p);
      if (!entry) {
        report.fail(p, "원격에 없음");
        continue;
      }
      const targets = [p];
      if (entry.isDir && opts.recursive) {
        for (const e of await ctx.transport.list(p, true)) targets.push(e.path);
      }
      for (const target of targets) {
        if (target === "") continue;
        await once(ctx, (t) => t.chmod(target, mode));
        report.ok({ path: target, action: "updated", reason: mode }, `chmod ${mode} ${target}`);
      }
    } catch (err) {
      if (err instanceof FTPError && UNSUPPORTED.has(err.code)) {
        throw new Error(`서버가 SITE CHMOD 를 지원하지 않음 (${err.message})`);
      }
      report.fail(p, message(err));
    }
  }
  report.print(opts.json);
}

export const registerFsOps: Register = (program, run) => {
  program
    .command("mkdir")
    .alias("md")
    .description("원격 디렉터리 생성")
    .argument("<paths...>", "만들 원격 경로")
    .option("-p, --parents", "상위 디렉터리도 만들고, 이미 있으면 오류 없이 넘어감")
    .option("--json", "JSON 출력")
    .action((paths: string[], opts, cmd: Command) => run(cmd, (ctx) => mkdirCmd(ctx, paths, opts)));

  program
    .command("mv")
    .alias("move")
    .description("원격 파일/디렉터리 이동·이름 변경. 덮어쓰는 대상 파일은 <대상>.bak 으로 보관")
    .argument("<paths...>", "원본... 대상 (원본이 여럿이면 대상은 디렉터리)")
    .option("-n, --dry-run", "실행 없이 계획만 출력")
    .option("-f, --force", "작업 집합의 push 안 한 로컬 수정이 있어도 진행")
    .option("--no-backup", "덮어쓰는 대상 파일을 .bak 없이 삭제")
    .option("--json", "JSON 출력")
    .action((paths: string[], opts: MvOpts, cmd: Command) => run(cmd, (ctx) => mvCmd(ctx, paths, opts)));

  program
    .command("cp")
    .alias("copy")
    .description("원격 파일/디렉터리 복사 (FTP 에 복사 명령이 없어 받아서 다시 올림). 덮어쓰는 대상 파일은 <대상>.bak 으로 보관")
    .argument("<paths...>", "원본... 대상 (원본이 여럿이면 대상은 디렉터리)")
    .option("-r, --recursive", "디렉터리 복사")
    .option("-R", "-r 과 같음")
    .option("-n, --dry-run", "실행 없이 계획만 출력")
    .option("-f, --force", "덮어쓸 작업 집합 파일에 push 안 한 로컬 수정이 있어도 진행")
    .option("--no-backup", "덮어쓰는 대상 파일을 .bak 없이 덮어씀")
    .option(...jobsOption)
    .option(...retriesOption)
    .option("--json", "JSON 출력")
    .action((paths: string[], opts: CpOpts & { R?: boolean }, cmd: Command) => {
      if (opts.R) opts.recursive = true;
      return run(cmd, (ctx) => cpCmd(ctx, paths, opts));
    });

  program
    .command("touch")
    .description("빈 원격 파일 생성. 이미 있으면 그대로 둠 (수정 시각은 바꾸지 않음)")
    .argument("<paths...>", "원격 경로")
    .option("-c, --no-create", "없는 파일은 만들지 않음")
    .option("--json", "JSON 출력")
    .action((paths: string[], opts: { create: boolean; json?: boolean }, cmd: Command) =>
      run(cmd, (ctx) => touchCmd(ctx, paths, { noCreate: !opts.create, json: opts.json })),
    );

  program
    .command("chmod")
    .description("원격 권한 변경 (SITE CHMOD, 숫자 모드만)")
    .argument("<mode>", "예: 644, 755")
    .argument("<paths...>", "원격 경로")
    .option("-R, --recursive", "하위 전체")
    .option("--json", "JSON 출력")
    .action((mode: string, paths: string[], opts, cmd: Command) =>
      run(cmd, (ctx) => chmodCmd(ctx, mode, paths, opts)),
    );
};

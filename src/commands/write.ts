import type { Command } from "commander";
import { jobsOption, printJson, retriesOption, type Register, type ResultRow } from "../cli.js";
import { patchIndex, type IndexOp } from "../indexer.js";
import { runPool, type Job } from "../parallel.js";
import { findEntry, hasUnpushedEdits, message, parentOf } from "../remote-ops.js";
import { isBinary, joinLines, readRemoteFile, splitLines } from "../remoteio.js";
import { parseSed, runSed } from "../sed.js";
import type { Context } from "../session.js";
import { normalizeRel, WorkSet } from "../state.js";
import { uploadJob } from "./upload.js";

interface WriteOpts {
  force?: boolean;
  backup: boolean;
  jobs: number;
  retries: number;
  json?: boolean;
}

interface WritePlan {
  rel: string;
  content: Buffer;
  exists: boolean;
  note: string;
}

/** 계획된 내용을 uploadJob(덮어쓰기 전 .bak, 크기 검증, 실패 시 복원)으로 올리고 인덱스·결과를 정리함 */
async function applyWrites(
  ctx: Context,
  ws: WorkSet,
  plans: WritePlan[],
  opts: WriteOpts,
  rows: ResultRow[],
  verb: string,
): Promise<void> {
  const done = new Set<string>();
  const jobs: Job[] = plans.map((p) => {
    const inner = uploadJob(ctx, p.rel, p.exists ? "modified" : "localOnly", p.content.length, opts.backup, p.content);
    return {
      path: p.rel,
      label: `${verb} ${p.rel}${p.note ? ` (${p.note})` : ""}`,
      async run(t) {
        await inner.run(t);
        done.add(p.rel);
      },
      abandon: (t) => (inner.abandon ? inner.abandon(t) : Promise.resolve()),
    };
  });
  const indexOps: IndexOp[] = [];
  let poolError: unknown;
  try {
    if (jobs.length > 0) {
      await runPool(ctx, jobs, { jobs: opts.jobs, retries: opts.retries, log: console.error, summary: false });
    }
  } catch (err) {
    poolError = err;
  } finally {
    for (const p of plans) {
      if (done.has(p.rel)) {
        rows.push({ path: p.rel, action: "updated", reason: p.note || undefined });
        indexOps.push({ op: "add", entry: { path: p.rel, size: p.content.length } });
        if (ws.get(p.rel)) {
          console.error(`작업 집합 파일 ${p.rel}: 원격이 바뀌었으므로 로컬 사본은 pull --force 로 다시 받아야 함`);
        }
      } else {
        rows.push({ path: p.rel, action: "failed", reason: "쓰기 실패" });
        process.exitCode = 2;
      }
    }
    await patchIndex(ctx, indexOps).catch((err) => console.error(`인덱스 갱신 실패 (find --refresh 권장): ${message(err)}`));
  }
  if (poolError) throw poolError;
}

// ---- tee ----

interface TeeOpts extends WriteOpts {
  append?: boolean;
  quiet?: boolean;
}

/** 접속 전에 stdin 을 모두 읽음 (로그인한 연결을 stdin 대기로 놀리지 않기 위함) */
export async function readStdin(): Promise<Buffer> {
  if (process.stdin.isTTY) throw new Error("표준 입력이 없음: 파이프나 heredoc 으로 내용을 넘겨야 함 (예: echo hi | ftcli tee a.txt)");
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c as string));
  return Buffer.concat(chunks);
}

async function tee(ctx: Context, args: string[], input: Buffer, opts: TeeOpts): Promise<void> {
  const ws = await WorkSet.load(ctx.cwd);
  const rows: ResultRow[] = [];
  const fail = (rel: string, reason: string): void => {
    rows.push({ path: rel, action: "failed", reason });
    console.error(`거부 ${rel}: ${reason}`);
    process.exitCode = 2;
  };
  const plans: WritePlan[] = [];
  for (const arg of args) {
    let rel: string;
    try {
      rel = normalizeRel(arg);
    } catch (err) {
      fail(arg, message(err));
      continue;
    }
    if (rel === "") {
      fail(arg, "파일 경로 아님");
      continue;
    }
    try {
      const entry = await findEntry(ctx.transport, rel);
      if (entry?.isDir) {
        fail(rel, "디렉터리임");
        continue;
      }
      if (!entry) {
        const parent = parentOf(rel);
        if (parent !== "" && !(await findEntry(ctx.transport, parent))?.isDir) {
          fail(rel, `상위 디렉터리 없음: ${parent} (mkdir -p 먼저)`);
          continue;
        }
      }
      if (entry && !opts.force) {
        if (await hasUnpushedEdits(ctx, ws, rel)) {
          fail(rel, "작업 집합에 push 하지 않은 로컬 수정 있음 (push 후 재시도 또는 -f)");
          continue;
        }
        if (!opts.append && input.length === 0 && entry.size > 0) {
          fail(rel, "입력이 비어 있어 기존 내용을 지우게 됨 (의도한 것이면 -f)");
          continue;
        }
      }
      let content = input;
      if (opts.append && entry) content = Buffer.concat([await readRemoteFile(ctx.transport, rel, true), input]);
      const note = opts.append && entry ? `${input.length}B 덧붙임` : `${content.length}B`;
      plans.push({ rel, content, exists: Boolean(entry), note });
    } catch (err) {
      fail(rel, message(err));
    }
  }
  if (!opts.quiet && !opts.json) process.stdout.write(input);
  await applyWrites(ctx, ws, plans, opts, rows, "tee");
  if (opts.json) printJson(rows);
}

// ---- sed -i ----

export interface SedInPlaceOpts extends WriteOpts {
  quiet?: boolean;
  regexpExtended?: boolean;
  dryRun?: boolean;
  forceLarge?: boolean;
}

export async function sedInPlace(ctx: Context, scripts: string[], files: string[], opts: SedInPlaceOpts): Promise<void> {
  const cmds = parseSed(scripts, Boolean(opts.regexpExtended));
  const ws = await WorkSet.load(ctx.cwd);
  const rows: ResultRow[] = [];
  const fail = (rel: string, reason: string): void => {
    rows.push({ path: rel, action: "failed", reason });
    console.error(`실패 ${rel}: ${reason}`);
    process.exitCode = 2;
  };
  const plans: WritePlan[] = [];
  for (const arg of files) {
    let rel: string;
    try {
      rel = normalizeRel(arg);
    } catch (err) {
      fail(arg, message(err));
      continue;
    }
    if (rel === "") {
      fail(arg, "파일 경로 아님");
      continue;
    }
    try {
      if (!opts.force && (await hasUnpushedEdits(ctx, ws, rel))) {
        fail(rel, "작업 집합에 push 하지 않은 로컬 수정 있음 (push 후 재시도 또는 -f)");
        continue;
      }
      const buf = await readRemoteFile(ctx.transport, rel, opts.forceLarge);
      if (isBinary(buf)) {
        fail(rel, "바이너리 파일로 보여 수정하지 않음");
        continue;
      }
      const text = buf.toString("utf8");
      const { lines, trailingNewline } = splitLines(text);
      const res = runSed(cmds, lines, Boolean(opts.quiet));
      const next = joinLines(res.out, trailingNewline || !res.endsAtLastLine);
      if (next === text) {
        rows.push({ path: rel, action: "skipped", reason: "변경 없음" });
        console.error(`변경 없음 ${rel}`);
        continue;
      }
      const parts = [
        res.changedLines > 0 ? `${res.changedLines}줄 치환` : "",
        res.deletedLines > 0 ? `${res.deletedLines}줄 삭제` : "",
      ].filter(Boolean);
      const note = parts.join(", ") || "내용 변경";
      if (opts.dryRun) {
        rows.push({ path: rel, action: "planned", reason: note });
        console.error(`[dry-run] sed -i ${rel} (${note})`);
        continue;
      }
      plans.push({ rel, content: Buffer.from(next, "utf8"), exists: true, note });
    } catch (err) {
      fail(rel, message(err));
    }
  }
  await applyWrites(ctx, ws, plans, opts, rows, "sed -i");
  if (opts.json) printJson(rows);
}

export const registerWrite: Register = (program, run) => {
  program
    .command("tee")
    .description("표준 입력을 원격 파일에 저장하고 stdout 으로도 출력 (heredoc 으로 파일 쓰기 대용). 덮어쓰기 전 원격 .bak 생성")
    .argument("<paths...>", "저장할 원격 파일")
    .option("-a, --append", "기존 내용 뒤에 덧붙임")
    .option("-q, --quiet", "stdout 으로 다시 출력하지 않음")
    .option("-f, --force", "빈 입력으로 덮어쓰기, push 안 한 로컬 수정이 있는 작업 집합 파일 덮어쓰기 허용")
    .option("--no-backup", "원격 .bak 생성 안 함")
    .option(...jobsOption)
    .option(...retriesOption)
    .option("--json", "JSON 출력")
    .action(async (paths: string[], opts: TeeOpts, cmd: Command) => {
      const input = await readStdin();
      return run(cmd, (ctx) => tee(ctx, paths, input, opts));
    });
};

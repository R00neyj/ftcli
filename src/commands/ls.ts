import type { Command } from "commander";
import { printJson, type Register } from "../cli.js";
import type { Context } from "../session.js";
import { normalizeRel } from "../state.js";
import type { RemoteEntry } from "../transport/types.js";

interface LsOpts {
  r?: boolean;
  recursive?: boolean;
  reverse?: boolean;
  t?: boolean;
  l?: boolean;
  json?: boolean;
}

/** -t 정렬용으로 MDTM 을 보충 조회할 최대 파일 수 (명령 폭주 방지) */
const MTIME_FILL_LIMIT = 200;

/**
 * -r 의 뜻: -t / -l 과 함께 쓰면 bash 처럼 역순(ls -ltr), 단독이면 하위 포함(이전 동작 유지).
 * 하위 포함은 -R / --recursive 로 항상 지정 가능함
 */
export function lsMode(opts: LsOpts): { recursive: boolean; reverse: boolean } {
  const rIsReverse = Boolean(opts.r && (opts.t || opts.l));
  return {
    recursive: Boolean(opts.recursive || (opts.r && !rIsReverse)),
    reverse: Boolean(opts.reverse || rIsReverse),
  };
}

/** LIST 만 되는 서버(MLSD 없음)는 수정 시각을 주지 않으므로 파일 수가 적으면 MDTM 으로 채움 */
async function fillMtimes(ctx: Context, entries: RemoteEntry[]): Promise<void> {
  const missing = entries.filter((e) => !e.isDir && !e.mtime);
  if (missing.length === 0 || missing.length > MTIME_FILL_LIMIT) return;
  for (const e of missing) {
    try {
      const st = await ctx.transport.stat(e.path);
      if (st?.mtime) e.mtime = st.mtime;
    } catch {
      return;
    }
  }
}

export async function ls(ctx: Context, dirArg: string, opts: LsOpts): Promise<void> {
  const dir = normalizeRel(dirArg);
  const { recursive, reverse } = lsMode(opts);
  const entries = await ctx.transport.list(dir, recursive);
  entries.sort((a, b) => (reverse ? -1 : 1) * a.path.localeCompare(b.path));
  if (opts.t) {
    await fillMtimes(ctx, entries);
    const unknown = entries.filter((e) => !e.mtime).length;
    if (unknown > 0 && unknown === entries.length) {
      console.error("경고: 서버가 수정 시각을 주지 않아 -t 로 정렬할 수 없음 (이름 순으로 출력함)");
    } else if (unknown > 0) {
      console.error(`경고: 서버가 수정 시각을 주지 않은 ${unknown}개 항목은 -t 정렬에서 맨 뒤에 둠`);
    }
    // 최근 수정 순 (역순이면 오래된 순). 수정 시각을 모르는 항목은 항상 뒤로
    entries.sort((a, b) => {
      if (!a.mtime || !b.mtime) return (a.mtime ? 0 : 1) - (b.mtime ? 0 : 1);
      return (reverse ? -1 : 1) * b.mtime.localeCompare(a.mtime);
    });
  }
  if (opts.json) {
    printJson(entries.map((e) => ({ path: e.path, size: e.size, isDir: e.isDir, mtime: e.mtime ?? null })));
    return;
  }
  for (const e of entries) {
    console.log(`${e.isDir ? "d" : "-"} ${String(e.size).padStart(10)} ${e.path}${e.isDir ? "/" : ""}`);
  }
}

export const registerLs: Register = (program, run) => {
  program
    .command("ls")
    .alias("dir")
    .description("원격 목록")
    .argument("[dir]", "원격 경로", "")
    // ls -lh 처럼 -h 를 붙여 쓰는 습관 때문에 도움말은 --help 만 사용
    .helpOption("--help", "display help for command")
    .option("-r", "단독이면 하위 포함, -t / -l 과 함께 쓰면 역순 (ls -ltr = 오래된 순)")
    .option("-R, --recursive", "하위 포함")
    .option("--reverse", "역순 정렬")
    .option("-t", "최근 수정 순 정렬")
    .option("-l", "호환용 (항상 종류·크기 표시)")
    .option("-a, --all", "호환용 (숨김 파일도 항상 표시)")
    .option("-h", "호환용 (크기는 항상 바이트)")
    .option("--json", "JSON 출력")
    .action((dir: string, opts: LsOpts, cmd: Command) => run(cmd, (ctx) => ls(ctx, dir, opts)));
};

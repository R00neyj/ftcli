import type { Command } from "commander";
import { printJson, type Register } from "../cli.js";
import type { Context } from "../session.js";

interface LsOpts {
  recursive?: boolean;
  R?: boolean;
  t?: boolean;
  json?: boolean;
}

export async function ls(ctx: Context, dir: string, opts: LsOpts): Promise<void> {
  const entries = await ctx.transport.list(dir, Boolean(opts.recursive || opts.R));
  entries.sort((a, b) => a.path.localeCompare(b.path));
  // -t: 최근 수정 순 (수정 시각을 모르는 항목은 뒤로)
  if (opts.t) entries.sort((a, b) => (b.mtime ?? "").localeCompare(a.mtime ?? ""));
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
    .option("-r, --recursive", "하위 포함")
    .option("-R", "-r 과 같음")
    .option("-t", "최근 수정 순 정렬")
    .option("-l", "호환용 (항상 종류·크기 표시)")
    .option("-a, --all", "호환용 (숨김 파일도 항상 표시)")
    .option("-h", "호환용 (크기는 항상 바이트)")
    .option("--json", "JSON 출력")
    .action((dir: string, opts: LsOpts, cmd: Command) => run(cmd, (ctx) => ls(ctx, dir === "." ? "" : dir, opts)));
};

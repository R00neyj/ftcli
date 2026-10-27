#!/usr/bin/env node
import { Command } from "commander";
import path from "node:path";
import { backup } from "./commands/backup.js";
import { diff } from "./commands/diff.js";
import { download } from "./commands/download.js";
import { init } from "./commands/init.js";
import { ls } from "./commands/ls.js";
import { upload } from "./commands/upload.js";
import { withContext, type Context, type GlobalOpts } from "./session.js";

const program = new Command();
program
  .name("ftcli")
  .description("FTP list / diff / upload / download / backup")
  .option("-C, --cwd <dir>", "작업 디렉터리 (기본: 현재)")
  .option("--password <pw>", "비밀번호 (기본: FTPCLI_PASSWORD 환경 변수)");

const run = (cmd: Command, fn: (ctx: Context) => Promise<void>) =>
  withContext(cmd.optsWithGlobals<GlobalOpts>(), fn);

program
  .command("init")
  .description(".ftcli/config.json 템플릿 생성")
  .action((_opts, cmd: Command) =>
    init(path.resolve(cmd.optsWithGlobals<GlobalOpts>().cwd ?? process.cwd())),
  );

program
  .command("ls")
  .description("원격 목록")
  .argument("[dir]", "원격 경로", "")
  .option("-r, --recursive", "하위 포함")
  .action((dir: string, opts, cmd: Command) => run(cmd, (ctx) => ls(ctx, dir, opts)));

program
  .command("diff")
  .description("로컬과 원격 비교 (파일 단위)")
  .argument("[files...]", "대상 경로 (생략 시 전체)")
  .option("--verify", "크기가 같은 파일도 해시로 비교")
  .action((files: string[], opts, cmd: Command) => run(cmd, (ctx) => diff(ctx, files, opts)));

program
  .command("upload")
  .description("변경/신규 파일 업로드 (덮어쓰기 전 원격 .bak 생성)")
  .argument("[files...]", "대상 경로 (생략 시 전체)")
  .option("-n, --dry-run", "실행 없이 대상만 출력")
  .option("--no-backup", "원격 .bak 생성 안 함")
  .action((files: string[], opts, cmd: Command) => run(cmd, (ctx) => upload(ctx, files, opts)));

program
  .command("download")
  .description("원격에만 있거나 다른 파일 다운로드 (덮어쓰기 전 로컬 백업)")
  .argument("[files...]", "대상 경로 (생략 시 전체)")
  .option("-n, --dry-run", "실행 없이 대상만 출력")
  .option("--no-backup", "덮어쓰는 로컬 파일 백업 안 함")
  .action((files: string[], opts, cmd: Command) => run(cmd, (ctx) => download(ctx, files, opts)));

program
  .command("backup")
  .description("원격 파일을 .ftcli/backups/<시각>/ 로 내려받아 보관")
  .argument("[paths...]", "대상 경로 (생략 시 전체)")
  .action((paths: string[], _opts, cmd: Command) => run(cmd, (ctx) => backup(ctx, paths)));

program.parseAsync().catch((err: Error) => {
  console.error(err.message);
  process.exitCode = 1;
});

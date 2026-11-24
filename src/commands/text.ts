import type { Command } from "commander";
import { intOpt, jobsOption, printJson, retriesOption, type Register } from "../cli.js";
import { mapPool, type MapOptions } from "../pmap.js";
import { isUtf8, joinLines, readRemoteFile, splitLines } from "../remoteio.js";
import { parseSed, runSed, SedError } from "../sed.js";
import type { Context } from "../session.js";
import { normalizeRel } from "../state.js";
import { sedInPlace, type SedInPlaceOpts } from "./write.js";

interface ReadOpts extends MapOptions {
  forceLarge?: boolean;
}

const message = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/** 경로들을 병렬로 받아 입력 순서대로 결과를 돌려줌. 실패는 stderr 에 기록하고 exitCode 2 */
async function readAll(
  ctx: Context,
  args: string[],
  opts: ReadOpts,
): Promise<{ rel: string; buf: Buffer }[]> {
  const rels: string[] = [];
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
      console.error(`실패 ${arg}: 파일 경로 아님`);
      process.exitCode = 2;
      continue;
    }
    rels.push(rel);
  }
  const results = await mapPool(ctx, rels, opts, (t, rel) => readRemoteFile(t, rel, opts.forceLarge));
  const out: { rel: string; buf: Buffer }[] = [];
  results.forEach((r, i) => {
    const rel = rels[i] as string;
    if (r.ok) out.push({ rel, buf: r.value });
    else {
      console.error(`실패 ${rel}: ${r.error.message}`);
      process.exitCode = 2;
    }
  });
  return out;
}

const write = (s: string): void => {
  process.stdout.write(s);
};

// ---- head / tail ----

interface HeadTailOpts extends ReadOpts {
  lines?: string;
  bytes?: string;
  quiet?: boolean;
}

/** "10" / "+10" / "-10" 파싱. tail 의 +N 은 N번째 줄부터 */
function parseCount(v: string | undefined, def: number): { n: number; fromStart: boolean } {
  if (v === undefined) return { n: def, fromStart: false };
  const m = /^(\+?)(\d+)$/.exec(v.trim());
  if (!m) throw new Error(`잘못된 개수: ${v} (0 이상 정수 또는 +N)`);
  return { n: Number(m[2]), fromStart: m[1] === "+" };
}

function sliceHead(buf: Buffer, opts: HeadTailOpts): Buffer {
  if (opts.bytes !== undefined) return buf.subarray(0, parseCount(opts.bytes, 0).n);
  const { n } = parseCount(opts.lines, 10);
  let pos = 0;
  for (let k = 0; k < n; k++) {
    const nl = buf.indexOf(0x0a, pos);
    if (nl < 0) return buf;
    pos = nl + 1;
  }
  return buf.subarray(0, pos);
}

function sliceTail(buf: Buffer, opts: HeadTailOpts): Buffer {
  if (opts.bytes !== undefined) {
    const { n, fromStart } = parseCount(opts.bytes, 0);
    return fromStart ? buf.subarray(Math.max(0, n - 1)) : buf.subarray(Math.max(0, buf.length - n));
  }
  const { n, fromStart } = parseCount(opts.lines, 10);
  if (fromStart) {
    let pos = 0;
    for (let k = 1; k < n; k++) {
      const nl = buf.indexOf(0x0a, pos);
      if (nl < 0) return buf.subarray(buf.length);
      pos = nl + 1;
    }
    return buf.subarray(pos);
  }
  if (n === 0) return buf.subarray(buf.length);
  // 마지막 줄바꿈은 줄 끝으로 보고 건너뜀
  let end = buf.length;
  if (end > 0 && buf[end - 1] === 0x0a) end--;
  let pos = end;
  for (let k = 0; k < n; k++) {
    const nl = buf.lastIndexOf(0x0a, pos - 1);
    if (nl < 0) return buf;
    pos = nl;
  }
  return buf.subarray(pos + 1);
}

async function headTail(ctx: Context, args: string[], opts: HeadTailOpts, which: "head" | "tail"): Promise<void> {
  parseCount(opts.lines, 10);
  if (opts.bytes !== undefined) parseCount(opts.bytes, 0);
  const files = await readAll(ctx, args, opts);
  const multi = args.length > 1 && !opts.quiet;
  files.forEach(({ rel, buf }, i) => {
    if (multi) write(`${i > 0 ? "\n" : ""}==> ${rel} <==\n`);
    process.stdout.write(which === "head" ? sliceHead(buf, opts) : sliceTail(buf, opts));
  });
}

// ---- wc ----

interface WcOpts extends ReadOpts {
  lines?: boolean;
  words?: boolean;
  bytes?: boolean;
  chars?: boolean;
  json?: boolean;
}

interface WcRow {
  path: string;
  lines: number;
  words: number;
  bytes: number;
  chars: number;
}

function count(rel: string, buf: Buffer): WcRow {
  let lines = 0;
  for (let i = buf.indexOf(0x0a); i >= 0; i = buf.indexOf(0x0a, i + 1)) lines++;
  const text = buf.toString("utf8");
  const words = text.split(/\s+/).filter((w) => w !== "").length;
  return { path: rel, lines, words, bytes: buf.length, chars: [...text].length };
}

async function wc(ctx: Context, args: string[], opts: WcOpts): Promise<void> {
  const rows = (await readAll(ctx, args, opts)).map(({ rel, buf }) => count(rel, buf));
  if (opts.json) {
    printJson(rows);
    return;
  }
  const any = opts.lines || opts.words || opts.bytes || opts.chars;
  const cols: (keyof WcRow)[] = any
    ? (["lines", "words", "chars", "bytes"] as const).filter((k) => opts[k])
    : ["lines", "words", "bytes"];
  const all = rows.length > 1
    ? [...rows, rows.reduce((t, r) => ({ path: "total", lines: t.lines + r.lines, words: t.words + r.words, bytes: t.bytes + r.bytes, chars: t.chars + r.chars }), { path: "total", lines: 0, words: 0, bytes: 0, chars: 0 })]
    : rows;
  const width = Math.max(1, ...all.flatMap((r) => cols.map((c) => String(r[c]).length)));
  for (const r of all) {
    console.log(`${cols.map((c) => String(r[c]).padStart(width)).join(" ")} ${r.path}`);
  }
}

// ---- sed (출력 전용, -i 는 내용 쓰기 묶음에서 처리) ----

export interface SedOpts extends ReadOpts {
  quiet?: boolean;
  expression: string[];
  regexpExtended?: boolean;
}

/** sed [옵션] 스크립트 파일... / sed -e 스크립트 [-e ...] 파일... */
export function splitSedArgs(args: string[], opts: SedOpts): { scripts: string[]; files: string[] } {
  if (opts.expression.length > 0) return { scripts: opts.expression, files: args };
  const [script, ...files] = args;
  if (script === undefined) throw new SedError("sed 스크립트 없음");
  return { scripts: [script], files };
}

async function sedPrint(ctx: Context, args: string[], opts: SedOpts): Promise<void> {
  const { scripts, files } = splitSedArgs(args, opts);
  const cmds = parseSed(scripts, Boolean(opts.regexpExtended));
  if (files.length === 0) throw new SedError("대상 원격 파일 없음 (표준 입력은 지원하지 않음)");
  for (const { buf } of await readAll(ctx, files, opts)) {
    // UTF-8 이 아닌 파일(EUC-KR 등)은 latin1 로 1바이트씩 다뤄 출력 바이트를 보존함 (ASCII 패턴만 정확히 맞음)
    const enc: BufferEncoding = isUtf8(buf) ? "utf8" : "latin1";
    const { lines, trailingNewline } = splitLines(buf.toString(enc));
    const { out, endsAtLastLine } = runSed(cmds, lines, Boolean(opts.quiet));
    process.stdout.write(Buffer.from(joinLines(out, trailingNewline || !endsAtLastLine), enc));
  }
}

const collect = (v: string, prev: string[]): string[] => [...prev, v];

export const registerText: Register = (program, run) => {
  const common = (c: Command): Command =>
    c
      .option("--force-large", "5MB 초과 파일도 처리")
      .option(...jobsOption)
      .option(...retriesOption);

  common(
    program
      .command("head")
      .description("원격 파일 앞부분 출력 (기본 10줄). head -20 형식도 가능")
      .argument("<paths...>", "원격 파일")
      .option("-n, --lines <n>", "출력할 줄 수")
      .option("-c, --bytes <n>", "출력할 바이트 수")
      .option("-q, --quiet", "여러 파일일 때 ==> 경로 <== 머리글 생략"),
  ).action((paths: string[], opts: HeadTailOpts, cmd: Command) =>
    run(cmd, (ctx) => headTail(ctx, paths, opts, "head")),
  );

  common(
    program
      .command("tail")
      .description("원격 파일 끝부분 출력 (기본 10줄). -n +N 은 N번째 줄부터")
      .argument("<paths...>", "원격 파일")
      .option("-n, --lines <n>", "출력할 줄 수 (+N 은 N번째 줄부터)")
      .option("-c, --bytes <n>", "출력할 바이트 수 (+N 은 N번째 바이트부터)")
      .option("-q, --quiet", "여러 파일일 때 ==> 경로 <== 머리글 생략"),
  ).action((paths: string[], opts: HeadTailOpts, cmd: Command) =>
    run(cmd, (ctx) => headTail(ctx, paths, opts, "tail")),
  );

  common(
    program
      .command("wc")
      .description("원격 파일 줄·단어·바이트 수")
      .argument("<paths...>", "원격 파일")
      .option("-l, --lines", "줄 수")
      .option("-w, --words", "단어 수")
      .option("-c, --bytes", "바이트 수")
      .option("-m, --chars", "문자 수")
      .option("--json", "JSON 출력"),
  ).action((paths: string[], opts: WcOpts, cmd: Command) => run(cmd, (ctx) => wc(ctx, paths, opts)));

  common(
    program
      .command("sed")
      .description("원격 파일에 sed 스크립트 적용 (p d q s 명령, 주소 N $ /re/ 범위 !). 기본은 stdout 출력")
      .argument("<args...>", "스크립트 + 원격 파일 (-e 사용 시 파일만)")
      .option("-n, --quiet", "자동 출력 끔 (p 로 지정한 줄만 출력)")
      .option("-e, --expression <script>", "스크립트 (반복 가능)", collect, [] as string[])
      .option("-E, --regexp-extended", "확장 정규식(ERE) 사용")
      .option("-r", "-E 와 같음")
      .option("-i, --in-place", "원격 파일을 직접 수정 (덮어쓰기 전 원격 .bak 생성, -i.bak 형식도 가능)")
      .option("--no-backup", "-i 시 원격 .bak 생성 안 함")
      .option("-f, --force", "-i 시 작업 집합 파일에 push 안 한 로컬 수정이 있어도 진행")
      .option("--dry-run", "-i 시 바뀔 파일과 줄 수만 출력")
      .option("--json", "-i 시 JSON 결과 출력"),
  ).action((args: string[], opts: SedOpts & SedInPlaceOpts & { r?: boolean; inPlace?: boolean }, cmd: Command) => {
    if (opts.r) opts.regexpExtended = true;
    // 스크립트 오류는 접속 전에 알림
    const { scripts, files } = splitSedArgs(args, opts);
    parseSed(scripts, Boolean(opts.regexpExtended));
    if (opts.inPlace) {
      if (files.length === 0) throw new SedError("대상 원격 파일 없음");
      return run(cmd, (ctx) => sedInPlace(ctx, scripts, files, opts));
    }
    return run(cmd, (ctx) => sedPrint(ctx, args, opts));
  });
};

import { intOpt, printJson, type Register } from "../cli.js";
import {
  buildIndex,
  hasGlobChars,
  loadIndexFile,
  matchGlob,
  underDir,
  userRegExp,
  warnIfStale,
  type IndexEntry,
} from "../indexer.js";
import type { Context } from "../session.js";
import { normalizeRel } from "../state.js";
import { posix } from "node:path";

interface FindOpts {
  regex?: boolean;
  refresh?: boolean;
  long?: boolean;
  limit: number;
  json?: boolean;
  name?: string;
  iname?: string;
  path?: string;
  type?: string;
  maxdepth?: number;
}

async function index(ctx: Context, dirArg: string): Promise<void> {
  const dir = normalizeRel(dirArg);
  const data = await buildIndex(ctx, dir);
  const count = data.entries.filter((e) => underDir(dir, e.path)).length;
  console.error(`${dir === "" ? "전체" : dir}: ${count}개 파일`);
}

function matcher(pattern: string, regex: boolean): (p: string) => boolean {
  if (regex) {
    const re = userRegExp(pattern, "i");
    return (p) => re.test(p);
  }
  if (hasGlobChars(pattern)) return (p) => matchGlob(pattern, p);
  const needle = pattern.replace(/\\/g, "/").toLowerCase();
  return (p) => p.toLowerCase().includes(needle);
}

/** bash find 식 glob: * 와 ? 는 / 도 포함해 일치 (-path 용), caseless 는 -iname / -ipath */
function shellGlob(pattern: string, caseless: boolean): RegExp {
  let src = "";
  for (const c of pattern) {
    if (c === "*") src += ".*";
    else if (c === "?") src += ".";
    else src += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${src}$`, caseless ? "i" : "");
}

const isStartDir = (arg: string): boolean => arg === "." || arg === "./" || arg.endsWith("/");

/** bash find 식 호출인지: 술어 옵션이 있거나 첫 인자가 시작 디렉터리(. 또는 끝이 /) */
const isBashStyle = (args: string[], opts: FindOpts): boolean =>
  opts.name !== undefined ||
  opts.iname !== undefined ||
  opts.type !== undefined ||
  opts.path !== undefined ||
  opts.maxdepth !== undefined ||
  (args.length > 0 && args.every(isStartDir));

/** 인덱스(파일만 있음)에서 시작 디렉터리 아래 파일과, 그 경로로부터 유추한 디렉터리를 만듦 */
export function bashFind(entries: IndexEntry[], args: string[], opts: FindOpts): IndexEntry[] {
  if (opts.type !== undefined && opts.type !== "f" && opts.type !== "d") {
    throw new Error(`-type 은 f 또는 d 만 지원함: ${opts.type}`);
  }
  const starts = (args.length > 0 ? args : ["."]).map(normalizeRel);
  const nameRe = opts.name !== undefined ? shellGlob(opts.name, false) : opts.iname !== undefined ? shellGlob(opts.iname, true) : undefined;
  const pathRe = opts.path !== undefined ? shellGlob(opts.path.replace(/^\.\//, ""), false) : undefined;
  const out = new Map<string, IndexEntry>();
  for (const start of starts) {
    const depthOf = (p: string): number => (start === "" ? p.split("/").length : p.split("/").length - start.split("/").length);
    const candidates: IndexEntry[] = [];
    for (const e of entries) {
      if (!underDir(start, e.path)) continue;
      if (opts.type !== "d") candidates.push(e);
      if (opts.type !== "f") {
        // 파일 경로의 상위 디렉터리 중 시작 디렉터리 아래인 것
        const parts = e.path.split("/");
        for (let k = parts.length - 1; k >= 1; k--) {
          const dir = parts.slice(0, k).join("/");
          if (dir === start || !underDir(start, dir)) break;
          candidates.push({ path: `${dir}/`, size: 0 });
        }
      }
    }
    for (const c of candidates) {
      const p = c.path.endsWith("/") ? c.path.slice(0, -1) : c.path;
      if (opts.maxdepth !== undefined && depthOf(p) > opts.maxdepth) continue;
      if (nameRe && !nameRe.test(posix.basename(p))) continue;
      if (pathRe && !pathRe.test(p)) continue;
      out.set(c.path, c);
    }
  }
  return [...out.values()].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

async function find(ctx: Context, args: string[], opts: FindOpts): Promise<void> {
  const bash = isBashStyle(args, opts);
  if (!bash && args.length !== 1) {
    throw new Error("패턴 하나가 필요함 (bash 식은 find . -name '*.php' 처럼 사용)");
  }
  const pattern = args.join(" ");
  const data = await loadIndexFile(ctx, { refresh: opts.refresh });
  if (!opts.refresh) warnIfStale(data);
  let hits: IndexEntry[];
  if (bash) hits = bashFind(data.entries, args, opts);
  else {
    const test = matcher(pattern, Boolean(opts.regex));
    hits = data.entries.filter((e) => test(e.path));
  }
  const shown: IndexEntry[] = hits.slice(0, opts.limit);
  if (opts.json) {
    printJson(shown);
  } else {
    for (const e of shown) {
      console.log(opts.long ? `${String(e.size).padStart(10)} ${e.path}` : e.path);
    }
  }
  if (hits.length === 0) console.error(`일치 없음: ${pattern || "."}`);
  else if (hits.length > shown.length) {
    console.error(`총 ${hits.length}개 중 ${shown.length}개만 표시함 (--limit 로 조정)`);
  }
}

export const registerFind: Register = (program, run) => {
  program
    .command("index")
    .description("원격 파일 인덱스(.ftcli/index.json) 재구축")
    .argument("[dir]", "재구축할 원격 하위 경로 (생략 시 전체)", "")
    .action((dir: string, _opts, cmd) => run(cmd, (ctx) => index(ctx, dir)));

  program
    .command("find")
    .description(
      "인덱스에서 원격 파일 경로 검색. ftcli find <패턴> (glob / 부분 문자열 / 정규식) 또는 bash 식 find [경로...] -name/-iname/-path/-type/-maxdepth",
    )
    .argument("[args...]", "패턴 하나, 또는 bash 식일 때 시작 경로들 (생략 시 .)")
    .option("--regex", "패턴을 정규식으로 해석")
    .option("--name <glob>", "파일 이름 glob (대소문자 구분, bash 의 -name)")
    .option("--iname <glob>", "파일 이름 glob (대소문자 무시, bash 의 -iname)")
    .option("--path <glob>", "전체 경로 glob (bash 의 -path)")
    .option("--type <t>", "f 파일 / d 디렉터리 (bash 의 -type). d 는 파일 경로에서 유추하므로 빈 디렉터리는 안 나옴")
    .option("--maxdepth <n>", "시작 경로 기준 최대 깊이 (bash 의 -maxdepth)", intOpt(0, 1000))
    .option("--refresh", "검색 전 인덱스 재구축")
    .option("-l, --long", "크기 표시")
    .option("--limit <n>", "최대 표시 개수", intOpt(1, Number.MAX_SAFE_INTEGER), 200)
    .option("--json", "JSON 출력")
    .action((args: string[], opts: FindOpts, cmd) => run(cmd, (ctx) => find(ctx, args, opts)));
};

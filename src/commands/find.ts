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

interface FindOpts {
  regex?: boolean;
  refresh?: boolean;
  long?: boolean;
  limit: number;
  json?: boolean;
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

async function find(ctx: Context, pattern: string, opts: FindOpts): Promise<void> {
  const test = matcher(pattern, Boolean(opts.regex));
  const data = await loadIndexFile(ctx, { refresh: opts.refresh });
  if (!opts.refresh) warnIfStale(data);
  const hits = data.entries.filter((e) => test(e.path));
  const shown: IndexEntry[] = hits.slice(0, opts.limit);
  if (opts.json) {
    printJson(shown);
  } else {
    for (const e of shown) {
      console.log(opts.long ? `${String(e.size).padStart(10)} ${e.path}` : e.path);
    }
  }
  if (hits.length === 0) console.error(`일치 없음: ${pattern}`);
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
    .description("인덱스에서 원격 파일 경로 검색 (glob / 부분 문자열 / 정규식)")
    .argument("<pattern>", "glob(*, **, ?) 또는 부분 문자열")
    .option("--regex", "패턴을 정규식으로 해석")
    .option("--refresh", "검색 전 인덱스 재구축")
    .option("-l, --long", "크기 표시")
    .option("--limit <n>", "최대 표시 개수", intOpt(1, Number.MAX_SAFE_INTEGER), 200)
    .option("--json", "JSON 출력")
    .action((pattern: string, opts: FindOpts, cmd) => run(cmd, (ctx) => find(ctx, pattern, opts)));
};

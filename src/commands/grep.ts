import { intOpt, jobsOption, printJson, retriesOption, type Register } from "../cli.js";
import { loadIndexFile, matchGlob, underDir, userRegExp, warnIfStale, type IndexEntry } from "../indexer.js";
import { mapPool } from "../pmap.js";
import type { Context } from "../session.js";
import { fetchBuffer, isBinary, SizeExceededError } from "../remoteio.js";
import { normalizeRel } from "../state.js";

interface GrepOpts {
  fixed?: boolean;
  ignoreCase?: boolean;
  wordRegexp?: boolean;
  invertMatch?: boolean;
  count?: boolean;
  context?: number;
  afterContext?: number;
  beforeContext?: number;
  glob: string[];
  include: string[];
  exclude: string[];
  excludeDir: string[];
  regexp: string[];
  maxSize: number;
  filesWithMatches?: boolean;
  maxCount?: number;
  jobs: number;
  retries: number;
  json?: boolean;
  refresh?: boolean;
}

interface Match {
  path: string;
  line: number;
  text: string;
  /** -A/-B/-C 사용 시에만 포함 */
  before?: string[];
  after?: string[];
}

/** 텍스트 출력용 행. match=false 는 문맥 줄 */
interface OutRow {
  line: number;
  text: string;
  match: boolean;
}

type FileResult = { binary: true } | { binary: false; matches: Match[]; rows: OutRow[] };

const escapeRegex = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** 패턴 여러 개(-e 반복)는 하나라도 맞으면 일치 */
export function lineMatcher(patterns: string[], opts: GrepOpts): (line: string) => boolean {
  const tests = patterns.map((p) => singleMatcher(p, opts));
  const any = tests.length === 1 ? (tests[0] as (line: string) => boolean) : (line: string) => tests.some((t) => t(line));
  return opts.invertMatch ? (line) => !any(line) : any;
}

function singleMatcher(pattern: string, opts: GrepOpts): (line: string) => boolean {
  const flags = opts.ignoreCase ? "i" : "";
  let test: (line: string) => boolean;
  if (opts.wordRegexp) {
    const src = opts.fixed ? escapeRegex(pattern) : pattern;
    const re = userRegExp(`(?<!\\w)(?:${src})(?!\\w)`, flags);
    test = (line) => re.test(line);
  } else if (!opts.fixed) {
    const re = userRegExp(pattern, flags);
    test = (line) => re.test(line);
  } else if (!opts.ignoreCase) {
    test = (line) => line.includes(pattern);
  } else {
    const needle = pattern.toLowerCase();
    test = (line) => line.toLowerCase().includes(needle);
  }
  return test;
}

export function scan(rel: string, buf: Buffer, test: (line: string) => boolean, opts: GrepOpts): FileResult {
  if (isBinary(buf)) return { binary: true };
  const lines = buf.toString("utf8").split(/\r?\n/);
  if (lines.at(-1) === "") lines.pop();
  const limit = opts.filesWithMatches ? 1 : (opts.maxCount ?? Number.POSITIVE_INFINITY);
  const after = opts.afterContext ?? opts.context ?? 0;
  const before = opts.beforeContext ?? opts.context ?? 0;
  const withContext = !opts.filesWithMatches && !opts.count && (after > 0 || before > 0);
  const matches: Match[] = [];
  const printed = new Map<number, boolean>();
  for (let i = 0; i < lines.length && matches.length < limit; i++) {
    const text = lines[i] as string;
    if (!test(text)) continue;
    const m: Match = { path: rel, line: i + 1, text };
    if (withContext) {
      const from = Math.max(0, i - before);
      const to = Math.min(lines.length - 1, i + after);
      m.before = lines.slice(from, i);
      m.after = lines.slice(i + 1, to + 1);
      for (let j = from; j <= to; j++) if (!printed.get(j)) printed.set(j, j === i);
    } else {
      printed.set(i, true);
    }
    matches.push(m);
  }
  // 앞 매치의 문맥 줄로 먼저 들어간 줄이 뒤에서 매치가 된 경우 반영
  for (const m of matches) printed.set(m.line - 1, true);
  const rows = [...printed]
    .sort((a, b) => a[0] - b[0])
    .map(([i, match]) => ({ line: i + 1, text: lines[i] as string, match }));
  return { binary: false, matches, rows };
}

async function grep(ctx: Context, pattern: string | undefined, pathArgs: string[], opts: GrepOpts): Promise<void> {
  // -e 를 쓰면 첫 위치 인자도 경로임
  const patterns = opts.regexp.length > 0 ? opts.regexp : pattern !== undefined ? [pattern] : [];
  if (opts.regexp.length > 0 && pattern !== undefined) pathArgs = [pattern, ...pathArgs];
  if (patterns.length === 0) throw new Error("검색 패턴 없음");
  const test = lineMatcher(patterns, opts);
  const prefixes = pathArgs.map(normalizeRel);
  const index = await loadIndexFile(ctx, { refresh: opts.refresh });
  if (!opts.refresh) warnIfStale(index);
  const include = [...opts.glob, ...opts.include];
  const dirOf = (p: string): string[] => p.split("/").slice(0, -1);
  const globOk = (p: string): boolean =>
    (include.length === 0 || include.some((g) => matchGlob(g, p))) &&
    !opts.exclude.some((g) => matchGlob(g, p)) &&
    !opts.excludeDir.some((g) => dirOf(p).some((d) => matchGlob(g, d)));
  const entries: IndexEntry[] = index.entries.filter(
    (e) => (prefixes.length === 0 || prefixes.some((d) => underDir(d, e.path))) && globOk(e.path),
  );
  for (const p of new Set(prefixes)) {
    if (p === "" || index.entries.some((e) => underDir(p, e.path))) continue;
    let size: number | null;
    try {
      size = await ctx.transport.size(p);
    } catch (err) {
      console.error(`${p}: 존재 확인 실패: ${err instanceof Error ? err.message : String(err)}`);
      continue;
    }
    if (size === null) console.error(`${p}: 대상 없음(무시 규칙 또는 미존재)`);
    else if (globOk(p)) entries.push({ path: p, size });
  }
  const candidates = entries.filter((e) => e.size <= opts.maxSize);
  const oversized = entries.length - candidates.length;
  if (oversized > 0) {
    console.error(`크기 초과로 ${oversized}개 파일 건너뜀 (--max-size ${opts.maxSize})`);
  }
  if (candidates.length === 0) {
    console.error("검색 대상 파일 없음");
    if (opts.json) printJson([]);
    return;
  }

  const results = await mapPool(ctx, candidates, opts, async (t, e) =>
    scan(e.path, await fetchBuffer((dest) => t.downloadToStream(e.path, dest), opts.maxSize), test, opts),
  );

  const matches: Match[] = [];
  const perFile = new Map<string, number>();
  const rowsByFile = new Map<string, OutRow[]>();
  let binary = 0;
  let failed = 0;
  let grew = 0;
  results.forEach((r, i) => {
    const rel = candidates[i]?.path ?? "?";
    if (!r.ok && r.error instanceof SizeExceededError) {
      grew++;
    } else if (!r.ok) {
      failed++;
      console.error(`실패 ${rel}: ${r.error.message}`);
    } else if (r.value.binary) binary++;
    else {
      matches.push(...r.value.matches);
      perFile.set(rel, r.value.matches.length);
      if (r.value.rows.length > 0) rowsByFile.set(rel, r.value.rows);
    }
  });
  matches.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : a.line - b.line));

  if (opts.count) {
    const counts = [...perFile].sort((a, b) => (a[0] < b[0] ? -1 : 1));
    if (opts.json) printJson(counts.map(([path, count]) => ({ path, count })));
    else for (const [path, count] of counts) console.log(`${path}:${count}`);
  } else if (opts.filesWithMatches) {
    const files = [...new Set(matches.map((m) => m.path))];
    if (opts.json) printJson(files);
    else for (const f of files) console.log(f);
  } else if (opts.json) {
    printJson(matches);
  } else {
    const withContext = (opts.afterContext ?? opts.context ?? 0) > 0 || (opts.beforeContext ?? opts.context ?? 0) > 0;
    let prev: { path: string; line: number } | undefined;
    for (const [path, rows] of [...rowsByFile].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
      for (const r of rows) {
        if (withContext && prev && (prev.path !== path || r.line > prev.line + 1)) console.log("--");
        console.log(`${path}${r.match ? ":" : "-"}${r.line}${r.match ? ":" : "-"}${r.text}`);
        prev = { path, line: r.line };
      }
    }
  }

  if (binary > 0) console.error(`바이너리로 판단해 ${binary}개 파일 건너뜀`);
  if (matches.length === 0) console.error(`일치 없음 (${candidates.length}개 파일 검색함)`);
  if (grew > 0) console.error(`크기 초과(인덱스 오래됨)로 ${grew}개 파일 건너뜀 (--max-size ${opts.maxSize}, --refresh 권장)`);
  if (failed > 0) {
    console.error(`${failed}개 파일 검색 실패`);
    process.exitCode = 2;
  }
}

const collect = (v: string, prev: string[]): string[] => [...prev, v];

export const registerGrep: Register = (program, run) => {
  program
    .command("grep")
    .alias("rg")
    .description("원격 파일 내용 검색 (디스크 저장 없이 메모리로 받아 검색). 출력은 grep -n 형식 `경로:줄:내용`")
    .argument("[pattern]", "정규식 (기본) 또는 고정 문자열 (-F). -e 사용 시 생략")
    .argument("[paths...]", "검색 범위 원격 경로 (생략 시 전체)")
    .option("-F, --fixed", "패턴을 고정 문자열로 해석")
    .option("-i, --ignore-case", "대소문자 무시")
    .option("-w, --word-regexp", "단어 단위로 일치")
    .option("-v, --invert-match", "일치하지 않는 줄 출력")
    .option("-c, --count", "파일별 일치 줄 수만 출력")
    .option("-A, --after-context <n>", "일치 줄 뒤 n줄 함께 출력", intOpt(0, 1000))
    .option("-B, --before-context <n>", "일치 줄 앞 n줄 함께 출력", intOpt(0, 1000))
    .option("--context <n>", "일치 줄 앞뒤 n줄 함께 출력 (grep -C n 도 이 옵션으로 처리)", intOpt(0, 1000))
    .option("-E, --extended-regexp", "호환용 (패턴은 항상 JavaScript 정규식)")
    .option("-n, --line-number", "호환용 (줄 번호는 항상 출력)")
    .option("-r, --recursive", "호환용 (경로를 주면 항상 하위까지 검색)")
    .option("-R", "호환용 (-r 과 같음)")
    .option("-H, --with-filename", "호환용 (파일 경로는 항상 출력)")
    .option("-e, --regexp <pattern>", "검색 패턴 (반복 가능, 하나라도 맞으면 일치)", collect, [] as string[])
    .option("-g, --glob <g>", "후보 파일 glob 필터 (반복 가능)", collect, [] as string[])
    .option("--include <g>", "후보 파일 glob 필터 (--glob 과 같음, 반복 가능)", collect, [] as string[])
    .option("--exclude <g>", "제외할 파일 glob (반복 가능)", collect, [] as string[])
    .option("--exclude-dir <g>", "제외할 디렉터리 이름 glob (반복 가능)", collect, [] as string[])
    .option("-I", "호환용 (바이너리 파일은 항상 건너뜀)")
    .option("--max-size <bytes>", "이보다 큰 파일은 건너뜀", intOpt(1, Number.MAX_SAFE_INTEGER), 1048576)
    .option("-l, --files-with-matches", "일치한 파일 경로만 출력")
    .option("-m, --max-count <n>", "파일당 최대 일치 수", intOpt(1, Number.MAX_SAFE_INTEGER))
    .option(...jobsOption)
    .option(...retriesOption)
    .option("--json", "JSON 출력")
    .option("--refresh", "검색 전 인덱스 재구축")
    .action((pattern: string | undefined, paths: string[], opts: GrepOpts, cmd) =>
      run(cmd, (ctx) => grep(ctx, pattern, paths, opts)),
    );
};

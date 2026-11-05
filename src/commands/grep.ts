import { Writable } from "node:stream";
import { intOpt, jobsOption, printJson, retriesOption, type Register } from "../cli.js";
import { loadIndexFile, matchGlob, underDir, userRegExp, warnIfStale, type IndexEntry } from "../indexer.js";
import { mapPool } from "../pmap.js";
import type { Context } from "../session.js";
import { normalizeRel } from "../state.js";

interface GrepOpts {
  fixed?: boolean;
  ignoreCase?: boolean;
  glob: string[];
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
}

type FileResult = { binary: true } | { binary: false; matches: Match[] };

const BINARY_PROBE = 8192;

function lineMatcher(pattern: string, opts: GrepOpts): (line: string) => boolean {
  if (!opts.fixed) {
    const re = userRegExp(pattern, opts.ignoreCase ? "i" : "");
    return (line) => re.test(line);
  }
  if (!opts.ignoreCase) return (line) => line.includes(pattern);
  const needle = pattern.toLowerCase();
  return (line) => line.toLowerCase().includes(needle);
}

class SizeExceededError extends Error {
  readonly discardConnection = true;

  constructor(maxSize: number) {
    super(`크기 초과(인덱스 오래됨): ${maxSize}바이트 한도 넘음`);
  }
}

async function fetchBuffer(
  download: (dest: Writable) => Promise<void>,
  maxSize: number,
): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  let exceeded = false;
  const sink = new Writable({
    write(chunk: Buffer, _enc, cb) {
      total += chunk.length;
      if (total > maxSize) {
        exceeded = true;
        cb(new SizeExceededError(maxSize));
        return;
      }
      chunks.push(chunk);
      cb();
    },
  });
  try {
    await download(sink);
  } catch (err) {
    if (exceeded) throw new SizeExceededError(maxSize);
    throw err;
  }
  if (exceeded) throw new SizeExceededError(maxSize);
  return Buffer.concat(chunks);
}

function scan(rel: string, buf: Buffer, test: (line: string) => boolean, opts: GrepOpts): FileResult {
  if (buf.subarray(0, BINARY_PROBE).includes(0)) return { binary: true };
  const lines = buf.toString("utf8").split(/\r?\n/);
  if (lines.at(-1) === "") lines.pop();
  const limit = opts.filesWithMatches ? 1 : (opts.maxCount ?? Number.POSITIVE_INFINITY);
  const matches: Match[] = [];
  for (let i = 0; i < lines.length && matches.length < limit; i++) {
    const text = lines[i] as string;
    if (test(text)) matches.push({ path: rel, line: i + 1, text });
  }
  return { binary: false, matches };
}

async function grep(ctx: Context, pattern: string, pathArgs: string[], opts: GrepOpts): Promise<void> {
  const test = lineMatcher(pattern, opts);
  const prefixes = pathArgs.map(normalizeRel);
  const index = await loadIndexFile(ctx, { refresh: opts.refresh });
  if (!opts.refresh) warnIfStale(index);
  const globOk = (p: string): boolean => opts.glob.length === 0 || opts.glob.some((g) => matchGlob(g, p));
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
    else matches.push(...r.value.matches);
  });
  matches.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : a.line - b.line));

  if (opts.filesWithMatches) {
    const files = [...new Set(matches.map((m) => m.path))];
    if (opts.json) printJson(files);
    else for (const f of files) console.log(f);
  } else if (opts.json) {
    printJson(matches);
  } else {
    for (const m of matches) console.log(`${m.path}:${m.line}:${m.text}`);
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
    .description("원격 파일 내용 검색 (디스크 저장 없이 메모리로 받아 검색)")
    .argument("<pattern>", "정규식 (기본) 또는 고정 문자열 (-F)")
    .argument("[paths...]", "검색 범위 원격 경로 (생략 시 전체)")
    .option("-F, --fixed", "패턴을 고정 문자열로 해석")
    .option("-i, --ignore-case", "대소문자 무시")
    .option("--glob <g>", "후보 파일 glob 필터 (반복 가능)", collect, [] as string[])
    .option("--max-size <bytes>", "이보다 큰 파일은 건너뜀", intOpt(1, Number.MAX_SAFE_INTEGER), 1048576)
    .option("-l, --files-with-matches", "일치한 파일 경로만 출력")
    .option("-m, --max-count <n>", "파일당 최대 일치 수", intOpt(1, Number.MAX_SAFE_INTEGER))
    .option(...jobsOption)
    .option(...retriesOption)
    .option("--json", "JSON 출력")
    .option("--refresh", "검색 전 인덱스 재구축")
    .action((pattern: string, paths: string[], opts: GrepOpts, cmd) =>
      run(cmd, (ctx) => grep(ctx, pattern, paths, opts)),
    );
};

import { jobsOption, printJson, retriesOption, type Register, type StatusRow } from "../cli.js";
import { mapPool, type MapOptions } from "../pmap.js";
import type { Context } from "../session.js";
import { classify, localInfo, normalizeRel, WorkSet, type FileState, type LocalInfo } from "../state.js";

export interface StatusOpts extends MapOptions {
  json?: boolean;
  all?: boolean;
}

export const STATE_CODE: Record<FileState, string> = {
  clean: " ",
  "local-modified": "M",
  "remote-changed": "R",
  conflict: "C",
  "local-missing": "!",
  "remote-deleted": "D",
};

const message = (err: unknown): string => (err instanceof Error ? err.message : String(err));

export const underPrefix = (rel: string, prefix: string): boolean =>
  prefix === "" || rel === prefix || rel.startsWith(`${prefix}/`);

export function selectTracked(ws: WorkSet, prefixes: string[]): string[] {
  const all = ws.paths();
  if (prefixes.length === 0) return all;
  return all.filter((rel) => prefixes.some((p) => underPrefix(rel, p)));
}

export async function computeStates(
  ctx: Context,
  ws: WorkSet,
  paths: string[],
  opts: MapOptions,
): Promise<Map<string, FileState>> {
  const targets = selectTracked(ws, paths.map(normalizeRel));
  const states = new Map<string, FileState>();
  if (targets.length === 0) return states;

  const locals = new Map<string, LocalInfo | null>();
  for (const rel of targets) locals.set(rel, await localInfo(ctx.cwd, rel));
  const needRemote = targets.filter((rel) => locals.get(rel));
  const remotes = await mapPool(ctx, needRemote, opts, (t, rel) => t.stat(rel));

  const remoteOf = new Map(needRemote.map((rel, i) => [rel, remotes[i]] as const));
  for (const rel of targets) {
    const base = ws.get(rel);
    if (!base) continue;
    const local = locals.get(rel) ?? null;
    if (!local) {
      states.set(rel, classify(base, null, null));
      continue;
    }
    const r = remoteOf.get(rel);
    if (!r?.ok) {
      console.error(`원격 조회 실패 ${rel}: ${r ? message(r.error) : "결과 없음"}`);
      process.exitCode = 2;
      continue;
    }
    states.set(rel, classify(base, local, r.value));
  }
  return states;
}

async function status(ctx: Context, paths: string[], opts: StatusOpts): Promise<void> {
  const ws = await WorkSet.load(ctx.cwd);
  if (ws.paths().length === 0) {
    console.error("작업 집합 비어 있음 (ftcli pull 로 파일을 받아야 함)");
    if (opts.json) printJson([]);
    return;
  }
  const prefixes = paths.map(normalizeRel);
  for (const [i, p] of prefixes.entries()) {
    if (selectTracked(ws, [p]).length === 0) console.error(`작업 집합에 없음: ${paths[i]}`);
  }
  if (prefixes.length > 0 && selectTracked(ws, prefixes).length === 0) {
    if (opts.json) printJson([]);
    return;
  }

  const states = await computeStates(ctx, ws, prefixes, opts);
  const shown = [...states].filter(([, state]) => opts.all || state !== "clean");

  if (opts.json) {
    printJson(shown.map(([path, state]): StatusRow => ({ path, state })));
    return;
  }
  if (shown.length === 0) {
    console.error("변경 없음");
    return;
  }
  for (const [rel, state] of shown) console.log(`${STATE_CODE[state]} ${rel}`);
}

export const registerStatus: Register = (program, run) => {
  program
    .command("status")
    .description("작업 집합 파일 상태 (M 로컬 수정, R 원격 변경, C 충돌, ! 로컬 없음, D 원격 삭제)")
    .argument("[paths...]", "대상 경로 (생략 시 작업 집합 전체)")
    .option("-a, --all", "변경 없는 파일도 표시")
    .option("--json", "JSON 출력")
    .option(...jobsOption)
    .option(...retriesOption)
    .action((paths: string[], opts: StatusOpts, cmd) => run(cmd, (ctx) => status(ctx, paths, opts)));
};

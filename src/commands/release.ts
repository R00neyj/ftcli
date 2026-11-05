import { lstat, readdir, rm, rmdir, stat } from "node:fs/promises";
import path from "node:path";
import { InvalidArgumentError } from "commander";
import { jobsOption, printJson, retriesOption, type Register, type ResultRow } from "../cli.js";
import { STATE_DIR } from "../config.js";
import { mapPool } from "../pmap.js";
import type { Context } from "../session.js";
import { localInfo, normalizeRel, remoteVerdict, WorkSet, type LocalInfo } from "../state.js";

const PART_SUFFIX = ".ftcli-part";
const BACKUP_NAME = /^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})(?:-[A-Za-z0-9]+)?$/;
const SKIP_WALK_DIRS = new Set([".git", "node_modules"]);
const DAY_MS = 86_400_000;

interface ReleaseOpts {
  dryRun?: boolean;
  force?: boolean;
  offline?: boolean;
  jobs: number;
  retries: number;
  json?: boolean;
}

interface PruneOpts {
  keep: number;
  days?: number;
  dryRun?: boolean;
  parts?: boolean;
}

const strictInt = (v: string): number => {
  if (!/^\d+$/.test(v)) throw new InvalidArgumentError("0 이상의 정수여야 함");
  const n = Number(v);
  if (!Number.isSafeInteger(n) || n > 100000) throw new InvalidArgumentError("100000 이하여야 함");
  return n;
};

type Probe = { kind: "missing" } | { kind: "file"; info: LocalInfo } | { kind: "error"; message: string };

async function probe(cwd: string, rel: string): Promise<Probe> {
  try {
    const st = await lstat(path.join(cwd, rel));
    if (!st.isFile()) return { kind: "error", message: "일반 파일이 아님" };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { kind: "missing" };
    return { kind: "error", message: errMessage(err) };
  }
  const info = await localInfo(cwd, rel);
  return info ? { kind: "file", info } : { kind: "error", message: "로컬 파일 읽기 실패" };
}

const errMessage = (err: unknown): string => (err instanceof Error ? err.message : String(err));

const matchesPrefix = (rel: string, prefixes: string[]): boolean =>
  prefixes.length === 0 || prefixes.some((p) => p === "" || rel === p || rel.startsWith(`${p}/`));

async function removeEmptyParents(cwd: string, rel: string): Promise<void> {
  const parts = rel.split("/").slice(0, -1);
  while (parts.length > 0 && parts[0] !== STATE_DIR) {
    try {
      await rmdir(path.join(cwd, ...parts));
    } catch {
      return;
    }
    parts.pop();
  }
}

function printRows(rows: ResultRow[], dryRun: boolean | undefined): void {
  for (const r of rows) {
    const verb = { released: dryRun ? "[dry-run] 회수 예정" : "회수", skipped: "건너뜀", failed: "실패" }[
      r.action as "released" | "skipped" | "failed"
    ];
    const note = r.reason && r.reason !== "dry-run" ? ` (${r.reason})` : "";
    console.error(`${verb} ${r.path}${note}`);
  }
  const count = (a: ResultRow["action"]): number => rows.filter((r) => r.action === a).length;
  console.error(`result : ${count("released")} released, ${count("skipped")} skipped, ${count("failed")} failed`);
}

async function release(ctx: Context, paths: string[], opts: ReleaseOpts): Promise<void> {
  const prefixes = paths.map(normalizeRel);
  const ws = await WorkSet.load(ctx.cwd);
  const rows: ResultRow[] = [];
  try {
    const targets = ws.paths().filter((p) => matchesPrefix(p, prefixes));
    if (targets.length === 0) {
      console.error("회수 대상 없음");
      if (opts.json) printJson(rows);
      return;
    }

    const removable: string[] = [];
    const missing = new Set<string>();
    for (const rel of targets) {
      const base = ws.get(rel);
      if (!base) continue;
      const local = await probe(ctx.cwd, rel);
      if (local.kind === "missing") missing.add(rel);
      else if (local.kind === "error") {
        rows.push({ path: rel, action: "failed", reason: `로컬 확인 실패: ${local.message}` });
        process.exitCode = 2;
      } else if (local.info.sha256 === base.sha256 || opts.force) removable.push(rel);
      else rows.push({ path: rel, action: "skipped", reason: "로컬 수정됨 (--force 필요)" });
    }

    const toRelease = [...missing];
    if (opts.offline || opts.force) {
      toRelease.push(...removable);
    } else if (removable.length > 0) {
      const checks = await mapPool(ctx, removable, opts, (t, rel) => t.stat(rel));
      removable.forEach((rel, i) => {
        const res = checks[i];
        if (!res?.ok) {
          const why = res && !res.ok ? res.error.message : "알 수 없음";
          rows.push({ path: rel, action: "failed", reason: `원격 확인 실패: ${why}` });
          process.exitCode = 2;
        } else if (res.value === null) {
          rows.push({ path: rel, action: "skipped", reason: "원격에 없음 (로컬이 유일한 사본, --force 필요)" });
        } else if (remoteVerdict(ws.get(rel)!, res.value) === "changed") {
          rows.push({ path: rel, action: "skipped", reason: "원격 변경됨 (--force 필요)" });
        } else {
          toRelease.push(rel);
        }
      });
    }

    for (const rel of toRelease.sort()) {
      let reason = missing.has(rel) ? "로컬에 없음, 작업 집합에서만 제거" : undefined;
      const base = ws.get(rel);
      if (!missing.has(rel) && !opts.force && base) {
        const now = await probe(ctx.cwd, rel);
        if (now.kind === "error") {
          rows.push({ path: rel, action: "failed", reason: `로컬 확인 실패: ${now.message}` });
          process.exitCode = 2;
          continue;
        }
        if (now.kind === "file" && now.info.sha256 !== base.sha256) {
          rows.push({ path: rel, action: "skipped", reason: "로컬 수정됨 (--force 필요)" });
          continue;
        }
        if (now.kind === "missing") {
          missing.add(rel);
          reason = "로컬에 없음, 작업 집합에서만 제거";
        }
      }
      if (opts.dryRun) {
        rows.push({ path: rel, action: "released", reason: reason ?? "dry-run" });
        continue;
      }
      try {
        if (!missing.has(rel)) await rm(path.join(ctx.cwd, rel), { force: true });
        ws.delete(rel);
        await removeEmptyParents(ctx.cwd, rel);
        rows.push({ path: rel, action: "released", ...(reason ? { reason } : {}) });
      } catch (err) {
        rows.push({ path: rel, action: "failed", reason: errMessage(err) });
        process.exitCode = 2;
      }
    }

    rows.sort((a, b) => a.path.localeCompare(b.path));
    printRows(rows, opts.dryRun);
    if (opts.json) printJson(rows);
  } finally {
    if (!opts.dryRun) await ws.save();
  }
}

async function dirSize(dir: string): Promise<number> {
  let total = 0;
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) total += await dirSize(full);
    else if (e.isFile()) total += (await stat(full)).size;
  }
  return total;
}

const backupTime = (name: string): number => {
  const m = BACKUP_NAME.exec(name);
  if (!m) return Number.NaN;
  const [y, mo, d, h, mi, s] = m.slice(1).map(Number) as [number, number, number, number, number, number];
  return Date.UTC(y, mo - 1, d, h, mi, s);
};

async function findParts(dir: string, out: string[]): Promise<void> {
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (!SKIP_WALK_DIRS.has(e.name)) await findParts(full, out);
    } else if (e.isFile() && e.name.endsWith(PART_SUFFIX)) {
      out.push(full);
    }
  }
}

interface Sweep {
  count: number;
  bytes: number;
}

async function sweep(
  items: { label: string; file: string; size: () => Promise<number>; recursive: boolean }[],
  dryRun: boolean | undefined,
): Promise<Sweep> {
  const out: Sweep = { count: 0, bytes: 0 };
  for (const it of items) {
    try {
      const size = await it.size();
      if (!dryRun) await rm(it.file, { recursive: it.recursive, force: true });
      out.count++;
      out.bytes += size;
      console.error(`${dryRun ? "[dry-run] 삭제 예정" : "삭제"} ${it.label} (${size}B)`);
    } catch (err) {
      console.error(`실패 ${it.label}: ${errMessage(err)}`);
      process.exitCode = 2;
    }
  }
  return out;
}

async function prune(ctx: Context, opts: PruneOpts): Promise<void> {
  const root = path.join(ctx.cwd, STATE_DIR, "backups");
  const names = await readdir(root, { withFileTypes: true })
    .then((es) => es.filter((e) => e.isDirectory() && BACKUP_NAME.test(e.name)).map((e) => e.name))
    .catch(() => [] as string[]);
  names.sort().reverse();

  const cutoff = opts.days === undefined ? undefined : Date.now() - opts.days * DAY_MS;
  const doomed = names.filter(
    (name, i) => i >= opts.keep || (cutoff !== undefined && backupTime(name) < cutoff),
  );
  const verb = opts.dryRun ? "삭제 예정" : "삭제";
  const gain = opts.dryRun ? "확보 예정" : "확보";

  const backups = await sweep(
    doomed.map((name) => ({
      label: `backups/${name}`,
      file: path.join(root, name),
      size: () => dirSize(path.join(root, name)),
      recursive: true,
    })),
    opts.dryRun,
  );
  console.error(`백업 ${backups.count}개 ${verb}, ${backups.bytes}B ${gain} (유지 ${names.length - doomed.length}개)`);

  if (!opts.parts) return;
  const found: string[] = [];
  await findParts(ctx.cwd, found);
  const parts = await sweep(
    found.map((file) => ({
      label: path.relative(ctx.cwd, file).replace(/\\/g, "/"),
      file,
      size: async () => (await stat(file)).size,
      recursive: false,
    })),
    opts.dryRun,
  );
  console.error(`잔여 part ${parts.count}개 ${verb}, ${parts.bytes}B ${gain}`);
}

export const registerRelease: Register = (program, run) => {
  program
    .command("release [paths...]")
    .description("작업 집합의 로컬 파일 삭제로 공간 회수 (원격은 유지)")
    .option("-n, --dry-run", "삭제하지 않고 대상만 출력")
    .option("--force", "수정됨/원격 삭제 파일도 회수")
    .option("--offline", "원격 존재 확인 생략")
    .option(...jobsOption)
    .option(...retriesOption)
    .option("--json", "결과를 JSON 으로 출력")
    .action((paths: string[], opts: ReleaseOpts, cmd) => run(cmd, (ctx) => release(ctx, paths, opts)));

  program
    .command("prune")
    .description(".ftcli/backups 보존 정책 적용 (최신 n개 유지, 오래된 것 삭제)")
    .option("--keep <n>", "최신 n개 유지", strictInt, 5)
    .option("--days <n>", "n일보다 오래된 백업도 삭제", strictInt)
    .option("-n, --dry-run", "삭제하지 않고 대상만 출력")
    .option("--parts", "잔여 *.ftcli-part 파일도 삭제")
    .action((opts: PruneOpts, cmd) => run(cmd, (ctx) => prune(ctx, opts)));
};

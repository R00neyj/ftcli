import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { InvalidArgumentError, type Command } from "commander";
import { configPath, configTemplate, writeConfig, type Config } from "../config.js";
import type { GlobalOpts } from "../session.js";
import { decodeText, parseSites, type SiteRecord } from "../sites.js";

interface ImportOpts {
  host?: string;
  port?: number;
  secure?: string;
  remoteRoot?: string;
  force?: boolean;
  dryRun?: boolean;
}

type Outcome =
  | { kind: "create" | "update"; dir: string; cfg: Config }
  | { kind: "exists"; dir: string }
  | { kind: "error"; dir: string; reason: string };

const portOption = (v: string): number => {
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1 || n > 65535) throw new InvalidArgumentError("1~65535 정수여야 함");
  return n;
};

function parseSecure(v: string): Config["secure"] | undefined {
  const s = v.trim().toLowerCase();
  if (s === "implicit") return "implicit";
  if (["true", "yes", "y", "1", "ftps", "explicit", "o"].includes(s)) return true;
  if (["false", "no", "n", "0", "ftp", "x", ""].includes(s)) return false;
  return undefined;
}

/** `ftp://host:2121/` 형태도 허용 */
function splitHost(raw: string): { host: string; port?: string } {
  const m = /^(?:s?ftps?:\/\/)?([^/:]+)(?::(\d+))?\/?$/i.exec(raw.trim());
  return m?.[1] ? { host: m[1], port: m[2] } : { host: raw.trim() };
}

async function plan(rec: SiteRecord, root: string, opts: ImportOpts, dup: Set<string>): Promise<Outcome> {
  const v = rec.values;
  const label = v.dir ?? `(폴더 이름 없음) ${rec.source}`;
  const fail = (reason: string): Outcome => ({ kind: "error", dir: label, reason: `${reason} — ${rec.source}` });

  if (!v.dir) return fail("폴더(dir) 없음");
  if (rec.conflicts.length > 0) return fail(`값이 둘 이상인 필드: ${rec.conflicts.join(", ")}`);
  const dir = path.resolve(root, v.dir);
  if (dup.has(dir)) return fail("같은 폴더가 입력에 두 번 이상 나옴");
  const isDir = await stat(dir).then(
    (s) => s.isDirectory(),
    () => false,
  );
  if (!isDir) return fail(`로컬 폴더 없음: ${dir}`);
  if (!v.user) return fail("user 없음");
  if (!v.password) return fail("password 없음");

  const fromHost = v.host ? splitHost(v.host) : undefined;
  const host = fromHost?.host ?? opts.host?.replaceAll("{user}", v.user);
  if (!host) return fail("host 없음 (문서에 없으면 --host 로 지정)");
  const portRaw = v.port ?? fromHost?.port;
  const port = portRaw !== undefined ? Number(portRaw) : opts.port;
  if (port !== undefined && (!Number.isInteger(port) || port < 1 || port > 65535)) return fail(`port 형식 오류: ${portRaw}`);
  const secureRaw = v.secure ?? opts.secure;
  const secure = secureRaw !== undefined ? parseSecure(secureRaw) : undefined;
  if (secureRaw !== undefined && secure === undefined) return fail(`secure 형식 오류: ${secureRaw}`);

  const fields: Partial<Config> = { host, user: v.user, password: v.password };
  if (port !== undefined) fields.port = port;
  if (secure !== undefined) fields.secure = secure;
  const remoteRoot = v.remoteRoot ?? opts.remoteRoot;
  if (remoteRoot !== undefined) fields.remoteRoot = remoteRoot;

  let existing: Config | undefined;
  try {
    existing = JSON.parse(await readFile(configPath(dir), "utf8")) as Config;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") return fail(`기존 config.json 읽기 실패: ${(err as Error).message}`);
  }
  if (existing && !opts.force) return { kind: "exists", dir: v.dir };
  // 갱신 시 문서에 없는 기존 값(maxLogins 등)은 유지
  return { kind: existing ? "update" : "create", dir: v.dir, cfg: { ...configTemplate, ...existing, ...fields } };
}

export async function importSites(root: string, files: string[], opts: ImportOpts): Promise<void> {
  const records: SiteRecord[] = [];
  for (const file of files) {
    records.push(...parseSites(decodeText(await readFile(file)), file));
  }
  if (records.length === 0) throw new Error("접속 정보를 찾지 못함 (README 의 import 입력 형식 참고)");

  const counts = new Map<string, number>();
  for (const r of records) {
    if (r.values.dir) {
      const d = path.resolve(root, r.values.dir);
      counts.set(d, (counts.get(d) ?? 0) + 1);
    }
  }
  const dup = new Set([...counts].filter(([, n]) => n > 1).map(([d]) => d));

  const tally = { create: 0, update: 0, exists: 0, error: 0 };
  for (const rec of records) {
    const o = await plan(rec, root, opts, dup);
    tally[o.kind]++;
    // 비밀번호는 출력하지 않음
    if (o.kind === "error") {
      console.log(`! ${o.dir}: ${o.reason}`);
    } else if (o.kind === "exists") {
      console.log(`= ${o.dir} (config.json 있음, 덮어쓰려면 --force)`);
    } else {
      if (!opts.dryRun) await writeConfig(path.resolve(root, o.dir), o.cfg);
      console.log(`${o.kind === "create" ? "+" : "~"} ${o.dir}  ${o.cfg.user}@${o.cfg.host}:${o.cfg.port} ${o.cfg.remoteRoot}`);
    }
  }
  const pre = opts.dryRun ? "[dry-run] " : "";
  console.log(`${pre}생성 ${tally.create} / 갱신 ${tally.update} / 유지 ${tally.exists} / 실패 ${tally.error}`);
  if (tally.error > 0) process.exitCode = 2;
}

export function registerImport(program: Command): void {
  program
    .command("import")
    .description("담당자 문서(CSV / Markdown)의 접속 정보로 폴더별 .ftcli/config.json 일괄 생성. 폴더는 -C 기준 상대 경로")
    .argument("<files...>", "입력 파일 (.csv 는 CSV, 그 외는 Markdown 으로 읽음)")
    .option("--host <host>", "문서에 host 가 없을 때 기본값. {user} 는 계정명으로 치환")
    .option("--port <n>", "문서에 port 가 없을 때 기본값", portOption)
    .option("--secure <v>", "문서에 secure 가 없을 때 기본값 (true / false / implicit)", (v: string) => {
      if (parseSecure(v) === undefined) throw new InvalidArgumentError("true / false / implicit 중 하나여야 함");
      return v;
    })
    .option("--remote-root <dir>", "문서에 원격 경로가 없을 때 기본값")
    .option("--force", "기존 config.json 도 갱신 (문서에 없는 기존 값은 유지)")
    .option("-n, --dry-run", "파일을 쓰지 않고 결과만 출력")
    .action((files: string[], opts: ImportOpts, cmd: Command) =>
      importSites(path.resolve(cmd.optsWithGlobals<GlobalOpts>().cwd ?? process.cwd()), files, opts),
    );
}

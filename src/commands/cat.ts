import { PassThrough } from "node:stream";
import { finished } from "node:stream/promises";
import type { Register } from "../cli.js";
import type { Context } from "../session.js";
import { normalizeRel } from "../state.js";
import { mapPool } from "../pmap.js";
import { readRemoteFile, splitLines } from "../remoteio.js";
import type { Transport } from "../transport/types.js";

const MAX_BYTES = 5 * 1024 * 1024;

interface CatOpts {
  forceLarge?: boolean;
  number?: boolean;
}

const isEpipe = (err: unknown): boolean => (err as NodeJS.ErrnoException | null)?.code === "EPIPE";

async function streamToStdout(t: Transport, rel: string, state: { broken: boolean }): Promise<void> {
  const pt = new PassThrough();
  pt.pipe(process.stdout, { end: false });
  const onStdoutError = (err: Error) => {
    state.broken = isEpipe(err);
    pt.destroy(err);
  };
  process.stdout.once("error", onStdoutError);
  const flushed = finished(pt);
  flushed.catch(() => {});
  try {
    await t.downloadToStream(rel, pt);
    if (!pt.writableEnded) pt.end();
    await flushed;
  } catch (err) {
    pt.destroy();
    throw err;
  } finally {
    process.stdout.off("error", onStdoutError);
    pt.unpipe(process.stdout);
  }
}

async function tryReconnect(reconnect: () => Promise<void>): Promise<boolean> {
  try {
    await reconnect();
    return true;
  } catch {
    return false;
  }
}

async function catImpl(ctx: Context, paths: string[], opts: CatOpts): Promise<void> {
  let t = ctx.transport;
  const opened: Transport[] = [];
  const state = { broken: false };
  const multi = paths.length > 1;
  let failed = 0;
  let dirty = false;
  const reconnect = async (): Promise<void> => {
    const prev = t;
    t = await ctx.open();
    opened.push(t);
    if (opened.includes(prev)) prev.close();
    dirty = false;
  };
  try {
    for (let i = 0; i < paths.length; i++) {
      const arg = paths[i]!;
      let rel = arg;
      try {
        rel = normalizeRel(arg);
        if (rel === "") {
          console.error(`건너뜀 ${arg}: 파일 경로 아님`);
          failed++;
          continue;
        }
        if (dirty) await reconnect();
        let size: number | null;
        try {
          size = await t.size(rel);
        } catch {
          dirty = true;
          await reconnect();
          try {
            size = await t.size(rel);
          } catch (err) {
            dirty = true;
            throw err;
          }
        }
        if (size === null) {
          console.error(`실패 ${rel}: 원격에 없음`);
          failed++;
          continue;
        }
        if (size > MAX_BYTES && !opts.forceLarge) {
          console.error(`실패 ${rel}: ${size}B 로 5MB 초과, --force-large 필요함`);
          failed++;
          continue;
        }
        if (multi) console.error(`== ${rel} ==`);
        try {
          await streamToStdout(t, rel, state);
        } catch (err) {
          if (!state.broken) dirty = true;
          throw err;
        }
      } catch (err) {
        if (state.broken) break;
        console.error(`실패 ${rel}: ${err instanceof Error ? err.message : String(err)}`);
        failed++;
        if (dirty && !(await tryReconnect(reconnect))) {
          const rest = paths.slice(i + 1);
          for (const r of rest) console.error(`실패 ${r}: 재연결 실패로 중단됨`);
          failed += rest.length;
          break;
        }
      }
    }
  } finally {
    for (const o of opened) o.close();
  }
  if (failed > 0) process.exitCode = 2;
}

/** cat -n: 줄 번호(6칸 + 탭)를 붙여 출력. 여러 파일이어도 번호는 이어서 셈 (GNU cat 과 같음) */
async function catNumbered(ctx: Context, paths: string[], opts: CatOpts): Promise<void> {
  const rels: string[] = [];
  for (const arg of paths) {
    try {
      const rel = normalizeRel(arg);
      if (rel === "") throw new Error("파일 경로 아님");
      rels.push(rel);
    } catch (err) {
      console.error(`실패 ${arg}: ${err instanceof Error ? err.message : String(err)}`);
      process.exitCode = 2;
    }
  }
  const results = await mapPool(ctx, rels, { jobs: 4, retries: 1 }, (t, rel) => readRemoteFile(t, rel, opts.forceLarge));
  let n = 0;
  results.forEach((r, i) => {
    if (!r.ok) {
      console.error(`실패 ${rels[i]}: ${r.error.message}`);
      process.exitCode = 2;
      return;
    }
    const { lines, trailingNewline } = splitLines(r.value.toString("utf8"));
    const out = lines.map((l) => `${String(++n).padStart(6)}\t${l}`);
    process.stdout.write(out.join("\n") + (out.length > 0 && trailingNewline ? "\n" : ""));
  });
}

export const registerCat: Register = (program, run) => {
  program
    .command("cat <paths...>")
    .alias("type")
    .description("원격 파일 내용을 다운로드 없이 stdout 으로 출력함")
    .option("--force-large", "5MB 초과 파일도 출력")
    .option("-n, --number", "줄 번호 붙여 출력")
    .action((paths: string[], opts: CatOpts, cmd) =>
      run(cmd, (ctx) => (opts.number ? catNumbered(ctx, paths, opts) : catImpl(ctx, paths, opts))),
    );
};

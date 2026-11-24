import { PassThrough } from "node:stream";
import { finished } from "node:stream/promises";
import type { Register } from "../cli.js";
import type { Context } from "../session.js";
import { normalizeRel } from "../state.js";
import type { Transport } from "../transport/types.js";

const MAX_BYTES = 5 * 1024 * 1024;

interface CatOpts {
  forceLarge?: boolean;
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

export const registerCat: Register = (program, run) => {
  program
    .command("cat <paths...>")
    .alias("type")
    .description("원격 파일 내용을 다운로드 없이 stdout 으로 출력함")
    .option("--force-large", "5MB 초과 파일도 출력")
    .action((paths: string[], opts: CatOpts, cmd) => run(cmd, (ctx) => catImpl(ctx, paths, opts)));
};

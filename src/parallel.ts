import type { Context } from "./session.js";
import { isAuthError, isTransient } from "./transport/errors.js";
import type { Transport } from "./transport/types.js";

export interface Job {
  path: string;
  label: string;
  run(t: Transport): Promise<void>;
  abandon?(t: Transport): Promise<void>;
  cleanup?(): Promise<void>;
}

export interface PoolOptions {
  jobs: number;
  retries: number;
}

const message = (err: unknown): string => (err instanceof Error ? err.message : String(err));

export async function runPool(ctx: Context, jobs: Job[], opts: PoolOptions): Promise<void> {
  let ok = 0;
  const failed: string[] = [];
  let next = 0;
  let fatal: Error | undefined;
  const take = (): Job | undefined => (fatal ? undefined : jobs[next++]);

  const slot = async (primary: boolean): Promise<void> => {
    let t: Transport | undefined = primary ? ctx.transport : undefined;
    try {
      if (!primary) {
        try {
          t = await ctx.open();
        } catch (err) {
          if (isAuthError(err)) fatal ??= err as Error;
          else console.error(`추가 연결 실패 (병렬도 축소): ${message(err)}`);
          return;
        }
      }
      for (let job = take(); job; job = take()) {
        for (let attempt = 0; ; attempt++) {
          try {
            t ??= await ctx.open();
            await job.run(t);
            ok++;
            console.log(job.label);
            break;
          } catch (err) {
            if (isAuthError(err)) {
              fatal ??= err as Error;
              console.error(`중단 ${job.path}: 인증 실패 - 원격 ${job.path} 상태 수동 확인 필요`);
              failed.push(job.path);
              return;
            }
            const transient = isTransient(err);
            if (transient && attempt < opts.retries) {
              console.error(`재시도 ${job.path} (${attempt + 1}/${opts.retries}): ${message(err)}`);
              t?.close();
              t = undefined;
              continue;
            }
            console.error(`실패 ${job.path}: ${message(err)}`);
            failed.push(job.path);
            await job.cleanup?.().catch(() => {});
            if (job.abandon) {
              try {
                if (transient) {
                  t?.close();
                  t = undefined;
                }
                t ??= await ctx.open();
                await job.abandon(t);
              } catch (abandonErr) {
                console.error(`정리 실패 ${job.path}: ${message(abandonErr)} - 원격 .bak 확인 필요`);
              }
            }
            break;
          }
        }
      }
    } finally {
      if (!primary) t?.close();
    }
  };

  const workers = Math.max(1, Math.min(opts.jobs, jobs.length));
  if (workers > 1) console.log(`workers : ${workers}`);
  await Promise.all(Array.from({ length: workers }, (_, i) => slot(i === 0)));

  console.log(`result : ${ok} ok, ${failed.length} failed`);
  if (failed.length > 0) process.exitCode = 2;
  if (fatal) {
    const left = Math.max(0, jobs.length - next);
    throw new Error(`인증 실패로 중단 (미처리 ${left}건): ${fatal.message}`);
  }
}

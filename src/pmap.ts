import type { Context } from "./session.js";
import { isAuthError, isTransient } from "./transport/errors.js";
import type { Transport } from "./transport/types.js";

export interface MapOptions {
  jobs: number;
  retries: number;
}

export type MapResult<R> = { ok: true; value: R } | { ok: false; error: Error };

const toError = (err: unknown): Error => (err instanceof Error ? err : new Error(String(err)));

export async function mapPool<T, R>(
  ctx: Context,
  items: T[],
  opts: MapOptions,
  fn: (t: Transport, item: T, index: number) => Promise<R>,
): Promise<MapResult<R>[]> {
  const results: MapResult<R>[] = new Array(items.length);
  let next = 0;
  let fatal: Error | undefined;

  const slot = async (primary: boolean): Promise<void> => {
    let t: Transport | undefined = primary ? ctx.transport : undefined;
    try {
      if (!primary) {
        try {
          t = await ctx.open();
        } catch (err) {
          if (isAuthError(err)) fatal ??= toError(err);
          return;
        }
      }
      while (!fatal && next < items.length) {
        const index = next++;
        for (let attempt = 0; ; attempt++) {
          try {
            t ??= await ctx.open();
            results[index] = { ok: true, value: await fn(t, items[index] as T, index) };
            break;
          } catch (err) {
            if (isAuthError(err)) {
              fatal ??= toError(err);
              results[index] = { ok: false, error: toError(err) };
              return;
            }
            if (isTransient(err) && attempt < opts.retries) {
              t?.close();
              t = undefined;
              continue;
            }
            results[index] = { ok: false, error: toError(err) };
            if (isTransient(err)) {
              t?.close();
              t = undefined;
            }
            break;
          }
        }
      }
    } finally {
      if (t && t !== ctx.transport) t.close();
    }
  };

  const workers = Math.max(1, Math.min(opts.jobs, items.length));
  await Promise.all(Array.from({ length: workers }, (_, i) => slot(i === 0)));
  if (fatal) throw new Error(`인증 실패로 중단: ${fatal.message}`);
  for (let i = 0; i < items.length; i++) {
    results[i] ??= { ok: false, error: new Error("처리되지 않음") };
  }
  return results;
}

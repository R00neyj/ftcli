import { posix } from "node:path";
import type { Context } from "./session.js";
import { localInfo, type WorkSet } from "./state.js";
import { isPermanentReply, isTransient } from "./transport/errors.js";
import { BAK_SUFFIX, type RemoteEntry, type Transport } from "./transport/types.js";

/** 기존 .bak 을 새 백업으로 교체하는 동안 잠시 옮겨 두는 이름 */
const OLD_BAK_SUFFIX = ".ftcli-old";

export const message = (err: unknown): string => (err instanceof Error ? err.message : String(err));

export const parentOf = (rel: string): string => {
  const dir = posix.dirname(rel);
  return dir === "." ? "" : dir;
};

/** 550 같은 확정 응답만 "없음" 으로 보고 빈 목록을 돌려줌. 연결 오류·일시적 4xx 는 그대로 던짐 */
export async function listOrEmpty(t: Transport, dir: string): Promise<RemoteEntry[]> {
  try {
    return await t.list(dir, false);
  } catch (err) {
    if (!isPermanentReply(err)) throw err;
    return [];
  }
}

export async function findEntry(t: Transport, rel: string): Promise<RemoteEntry | undefined> {
  if (rel === "") return { path: "", size: 0, isDir: true };
  return (await listOrEmpty(t, parentOf(rel))).find((e) => e.path === rel);
}

export async function removeEntry(t: Transport, entry: RemoteEntry): Promise<void> {
  if (entry.isDir) await t.removeDir(entry.path);
  else await t.remove(entry.path, true);
}

/**
 * rel 을 rel.bak 으로 옮김. 기존 .bak 은 먼저 .bak.ftcli-old 로 비켜 두고,
 * 새 백업 이동이 끝난 뒤에만 지움 (이동 실패 시 원래 이름으로 되돌림)
 * 매 시도마다 상위 목록으로 진행 상태를 확인하므로 재시도해도 안전함
 */
export async function moveToBak(t: Transport, rel: string): Promise<void> {
  const bak = `${rel}${BAK_SUFFIX}`;
  const old = `${bak}${OLD_BAK_SUFFIX}`;
  const parent = await listOrEmpty(t, parentOf(rel));
  const relEntry = parent.find((e) => e.path === rel);
  const bakEntry = parent.find((e) => e.path === bak);
  let oldEntry = parent.find((e) => e.path === old);

  if (!relEntry) {
    // 이전 시도에서 이동은 끝났고 응답만 잃은 경우
    if (!bakEntry) throw new Error("원격에 없음");
    if (oldEntry) await removeEntry(t, oldEntry);
    return;
  }

  let stashed = false;
  if (bakEntry) {
    // 이전 실행이 남긴 .ftcli-old 는 현재 .bak 보다 오래된 것이므로 정리
    if (oldEntry) await removeEntry(t, oldEntry);
    await t.rename(bak, old);
    oldEntry = { ...bakEntry, path: old };
    stashed = true;
  }

  try {
    await t.rename(rel, bak);
  } catch (err) {
    const after = await listOrEmpty(t, parentOf(rel));
    const replyLost = !after.some((e) => e.path === rel) && after.some((e) => e.path === bak);
    if (!replyLost) {
      if (stashed) await t.rename(old, bak).catch(() => {});
      throw err;
    }
  }

  if (oldEntry) await removeEntry(t, oldEntry);
}

/** 작업 집합에 등록됐고 로컬 사본에 push 하지 않은 수정이 있는지 */
export async function hasUnpushedEdits(ctx: Context, ws: WorkSet, rel: string): Promise<boolean> {
  const base = ws.get(rel);
  if (!base) return false;
  const local = await localInfo(ctx.cwd, rel);
  return local !== null && local.sha256 !== base.sha256;
}

/**
 * 멱등이 아닌 원격 조작(rename 등)을 한 번 실행함. 일시적 오류로 연결이 끊겼으면
 * 다음 대상을 위해 연결만 새로 열고 오류는 그대로 던짐 (같은 조작을 재시도하지 않음)
 */
export async function once<T>(ctx: Context, fn: (t: Transport) => Promise<T>): Promise<T> {
  try {
    return await fn(ctx.transport);
  } catch (err) {
    if (isTransient(err)) {
      ctx.transport.close();
      ctx.transport = await ctx.open();
    }
    throw err;
  }
}

import { createHash } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { STATE_DIR, type Config } from "./config.js";

type Creds = Config & { password: string };

const lockPath = (cwd: string): string => path.join(cwd, STATE_DIR, "auth-lock.json");

const fingerprint = (c: Creds): string =>
  createHash("sha256").update(`${c.host}\n${c.port}\n${c.user}\n${c.password}`).digest("hex");

export async function assertNotLocked(cwd: string, cfg: Creds): Promise<void> {
  let lock: { fingerprint: string; at: string };
  try {
    lock = JSON.parse(await readFile(lockPath(cwd), "utf8"));
  } catch {
    return;
  }
  if (lock.fingerprint !== fingerprint(cfg)) return;
  throw new Error(
    `인증 실패 기록 있음 (${lock.at}). 같은 계정·비밀번호로 다시 접속하면 서버가 IP 를 차단할 수 있어 접속 안 함. 비밀번호를 고치거나, 확인 후 --retry-auth 로 1회 재시도`,
  );
}

export async function recordAuthFailure(cwd: string, cfg: Creds): Promise<void> {
  await mkdir(path.dirname(lockPath(cwd)), { recursive: true });
  await writeFile(
    lockPath(cwd),
    `${JSON.stringify({ fingerprint: fingerprint(cfg), at: new Date().toISOString() })}\n`,
  );
}

export const clearAuthLock = (cwd: string): Promise<void> => rm(lockPath(cwd), { force: true });

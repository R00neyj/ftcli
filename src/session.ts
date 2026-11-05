import type { Ignore } from "ignore";
import path from "node:path";
import { assertNotLocked, clearAuthLock, recordAuthFailure } from "./authlock.js";
import { loadConfig, type Config } from "./config.js";
import { loadIgnore } from "./ignore.js";
import { FtpTransport } from "./transport/ftp.js";
import { isAuthError, LoginBudgetError } from "./transport/errors.js";
import type { Transport } from "./transport/types.js";

const DEFAULT_MAX_LOGINS = 10;
const LOGIN_SPACING_MS = 250;
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export interface GlobalOpts {
  cwd?: string;
  password?: string;
  retryAuth?: boolean;
}

export interface Context {
  cwd: string;
  cfg: Config;
  ig: Ignore;
  transport: Transport;
  open(): Promise<Transport>;
}

export async function withContext<T>(
  globals: GlobalOpts,
  fn: (ctx: Context) => Promise<T>,
): Promise<T> {
  const cwd = path.resolve(globals.cwd ?? process.cwd());
  const cfg = await loadConfig(cwd, globals.password);
  if (!globals.retryAuth) await assertNotLocked(cwd, cfg);
  const maxLogins = cfg.maxLogins ?? DEFAULT_MAX_LOGINS;
  let logins = 0;
  let nextLoginAt = 0;
  const open = async (): Promise<Transport> => {
    if (++logins > maxLogins) {
      throw new LoginBudgetError(
        `로그인 횟수 한도 초과 (${maxLogins}회). 서버 IP 차단 방지를 위해 접속을 중단함. 원인(연결 불안정 등) 확인 후 재실행`,
      );
    }
    const at = Math.max(Date.now(), nextLoginAt);
    nextLoginAt = at + LOGIN_SPACING_MS;
    if (at > Date.now()) await sleep(at - Date.now());
    const t = new FtpTransport(cfg);
    try {
      await t.connect();
    } catch (err) {
      t.close();
      if (isAuthError(err)) await recordAuthFailure(cwd, cfg);
      throw err;
    }
    return t;
  };
  const transport = await open();
  await clearAuthLock(cwd);
  const ctx: Context = { cwd, cfg, ig: await loadIgnore(cwd), transport, open };
  try {
    return await fn(ctx);
  } finally {
    ctx.transport.close();
  }
}

export function timestamp(): string {
  return new Date().toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15);
}

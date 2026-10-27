import type { Ignore } from "ignore";
import path from "node:path";
import { loadConfig, type Config } from "./config.js";
import { loadIgnore } from "./ignore.js";
import { FtpTransport } from "./transport/ftp.js";
import type { Transport } from "./transport/types.js";

export interface GlobalOpts {
  cwd?: string;
  password?: string;
}

export interface Context {
  cwd: string;
  cfg: Config;
  ig: Ignore;
  transport: Transport;
}

export async function withContext<T>(
  globals: GlobalOpts,
  fn: (ctx: Context) => Promise<T>,
): Promise<T> {
  const cwd = path.resolve(globals.cwd ?? process.cwd());
  const cfg = await loadConfig(cwd, globals.password);
  const transport = new FtpTransport(cfg);
  try {
    await transport.connect();
    return await fn({ cwd, cfg, ig: await loadIgnore(cwd), transport });
  } finally {
    transport.close();
  }
}

export function timestamp(): string {
  return new Date().toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15);
}

import { readFile } from "node:fs/promises";
import path from "node:path";

export const STATE_DIR = ".ftcli";

export interface Config {
  protocol: "ftp";
  host: string;
  port: number;
  user: string;
  password?: string;
  secure: boolean | "implicit";
  remoteRoot: string;
}

export const configTemplate: Config = {
  protocol: "ftp",
  host: "example.com",
  port: 21,
  user: "user",
  secure: false,
  remoteRoot: "/",
};

export function configPath(cwd: string): string {
  return path.join(cwd, STATE_DIR, "config.json");
}

export async function loadConfig(
  cwd: string,
  passwordFlag?: string,
): Promise<Config & { password: string }> {
  let raw: string;
  try {
    raw = await readFile(configPath(cwd), "utf8");
  } catch {
    throw new Error(`설정 파일 없음: ${configPath(cwd)} (ftcli init 먼저 실행)`);
  }
  const cfg = { ...configTemplate, ...JSON.parse(raw) } as Config;
  if (cfg.protocol !== "ftp") {
    throw new Error(`미지원 프로토콜: ${cfg.protocol} (sftp 는 추후 지원 예정)`);
  }
  const password = passwordFlag ?? process.env.FTPCLI_PASSWORD ?? cfg.password;
  if (!password) {
    throw new Error("비밀번호 없음: --password, FTPCLI_PASSWORD, config.password 중 하나 필요");
  }
  return { ...cfg, password };
}

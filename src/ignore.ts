import ignore, { type Ignore } from "ignore";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { STATE_DIR } from "./config.js";

const IGNORE_FILES = [".ftignore", ".ftpignore"];

export async function loadIgnore(cwd: string): Promise<Ignore> {
  const ig = ignore().add([STATE_DIR, ".git", "*.ftcli-part"]);
  for (const name of IGNORE_FILES) {
    try {
      ig.add(await readFile(path.join(cwd, name), "utf8"));
    } catch {
      // 파일 없으면 건너뜀
    }
  }
  return ig;
}

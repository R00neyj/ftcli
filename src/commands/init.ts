import { mkdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { STATE_DIR, configPath, configTemplate } from "../config.js";

export async function init(cwd: string): Promise<void> {
  const file = configPath(cwd);
  const exists = await stat(file).then(
    () => true,
    () => false,
  );
  if (exists) throw new Error(`이미 존재: ${file}`);
  await mkdir(path.join(cwd, STATE_DIR), { recursive: true });
  await writeFile(file, `${JSON.stringify(configTemplate, null, 2)}\n`);
  console.log(`생성: ${file}`);
}

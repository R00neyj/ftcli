import { stat } from "node:fs/promises";
import { configPath, configTemplate, writeConfig } from "../config.js";

export async function init(cwd: string): Promise<void> {
  const file = configPath(cwd);
  const exists = await stat(file).then(
    () => true,
    () => false,
  );
  if (exists) throw new Error(`이미 존재: ${file}`);
  await writeConfig(cwd, configTemplate);
  console.log(`생성: ${file}`);
}

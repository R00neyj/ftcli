import { rename, rm, stat } from "node:fs/promises";
import type { Transport } from "./transport/types.js";

const partPath = (dest: string): string => `${dest}.ftcli-part`;

export async function downloadVerified(
  t: Transport,
  rel: string,
  dest: string,
  size: number,
): Promise<void> {
  const part = partPath(dest);
  await t.download(rel, part);
  const got = (await stat(part)).size;
  if (got !== size) throw new Error(`VERIFY FAILED: 로컬 ${got}B != 원격 ${size}B`);
  await rename(part, dest);
}

export const removePart = (dest: string): Promise<void> => rm(partPath(dest), { force: true });

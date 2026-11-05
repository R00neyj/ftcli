import type { Context } from "./session.js";

export interface IndexEntry {
  path: string;
  size: number;
  mtime?: string;
}

export function loadIndex(_ctx: Context, _opts?: { refresh?: boolean }): Promise<IndexEntry[]> {
  return Promise.reject(new Error("not implemented"));
}

export function matchGlob(_pattern: string, _path: string): boolean {
  throw new Error("not implemented");
}

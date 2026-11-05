import type { Writable } from "node:stream";

export const BAK_SUFFIX = ".bak";

export interface RemoteEntry {
  path: string;
  size: number;
  isDir: boolean;
  mtime?: string;
}

export interface RemoteStat {
  size: number;
  mtime: string | null;
}

export interface Transport {
  connect(): Promise<void>;
  close(): void;
  list(dir: string, recursive: boolean): Promise<RemoteEntry[]>;
  upload(localPath: string, remotePath: string): Promise<void>;
  download(remotePath: string, localPath: string): Promise<void>;
  downloadToStream(remotePath: string, dest: Writable): Promise<void>;
  mkdirs(dirs: string[]): Promise<void>;
  size(remotePath: string): Promise<number | null>;
  stat(remotePath: string): Promise<RemoteStat | null>;
  rename(from: string, to: string): Promise<void>;
  remove(remotePath: string, ignoreMissing?: boolean): Promise<void>;
}

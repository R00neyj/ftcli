import type { Readable, Writable } from "node:stream";

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
  removeDir(remotePath: string): Promise<void>;
  /** 부모가 있어야 하며 이미 있으면 실패 (mkdir -p 는 mkdirs) */
  mkdir(remotePath: string): Promise<void>;
  /** SITE CHMOD. 서버가 지원하지 않으면 500/502/504 */
  chmod(remotePath: string, mode: string): Promise<void>;
  uploadFromStream(source: Readable, remotePath: string): Promise<void>;
}

export const BAK_SUFFIX = ".bak";

export interface RemoteEntry {
  path: string;
  size: number;
  isDir: boolean;
}

export interface Transport {
  connect(): Promise<void>;
  close(): void;
  list(dir: string, recursive: boolean): Promise<RemoteEntry[]>;
  upload(localPath: string, remotePath: string): Promise<void>;
  download(remotePath: string, localPath: string): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  remove(remotePath: string, ignoreMissing?: boolean): Promise<void>;
}

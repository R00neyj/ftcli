import { Client } from "basic-ftp";
import { mkdir } from "node:fs/promises";
import path, { posix } from "node:path";
import type { Config } from "../config.js";
import type { Writable } from "node:stream";
import { isDefinitive } from "./errors.js";
import type { RemoteEntry, RemoteStat, Transport } from "./types.js";


export class FtpTransport implements Transport {
  private client = new Client(30_000);

  constructor(private cfg: Config & { password: string }) {}

  async connect(): Promise<void> {
    const { host, port, user, password, secure } = this.cfg;
    await this.client.access({ host, port, user, password, secure });
  }

  close(): void {
    this.client.close();
  }

  async list(dir: string, recursive: boolean): Promise<RemoteEntry[]> {
    const out: RemoteEntry[] = [];
    const walk = async (rel: string): Promise<void> => {
      for (const item of await this.client.list(this.abs(rel))) {
        const itemRel = posix.join(rel, item.name);
        if (item.isDirectory) {
          out.push({ path: itemRel, size: 0, isDir: true });
          if (recursive) await walk(itemRel);
        } else if (item.isFile) {
          out.push({
            path: itemRel,
            size: item.size,
            isDir: false,
            mtime: item.modifiedAt?.toISOString(),
          });
        }
      }
    };
    await walk(dir);
    return out;
  }

  async upload(localPath: string, remotePath: string): Promise<void> {
    await this.client.uploadFrom(localPath, this.abs(remotePath));
  }

  async mkdirs(dirs: string[]): Promise<void> {
    const home = await this.client.pwd();
    try {
      for (const dir of new Set(dirs)) {
        await this.client.ensureDir(this.abs(dir));
        await this.client.cd(home);
      }
    } finally {
      await this.client.cd(home);
    }
  }

  async size(remotePath: string): Promise<number | null> {
    try {
      return await this.client.size(this.abs(remotePath));
    } catch (err) {
      const unparsable = err instanceof Error && /numerical value/.test(err.message);
      if (!isDefinitive(err) && !unparsable) throw err;
    }
    try {
      const dir = posix.dirname(remotePath);
      const hit = (await this.client.list(this.abs(dir === "." ? "" : dir))).find(
        (e) => e.name === posix.basename(remotePath) && e.isFile,
      );
      return hit ? hit.size : null;
    } catch (err) {
      if (isDefinitive(err)) return null;
      throw err;
    }
  }

  async stat(remotePath: string): Promise<RemoteStat | null> {
    const size = await this.size(remotePath);
    if (size === null) return null;
    try {
      return { size, mtime: (await this.client.lastMod(this.abs(remotePath))).toISOString() };
    } catch (err) {
      if (isDefinitive(err)) return { size, mtime: null };
      throw err;
    }
  }

  async downloadToStream(remotePath: string, dest: Writable): Promise<void> {
    await this.client.downloadTo(dest, this.abs(remotePath));
  }

  async download(remotePath: string, localPath: string): Promise<void> {
    await mkdir(path.dirname(localPath), { recursive: true });
    await this.client.downloadTo(localPath, this.abs(remotePath));
  }

  async rename(from: string, to: string): Promise<void> {
    await this.client.rename(this.abs(from), this.abs(to));
  }

  async remove(remotePath: string, ignoreMissing = false): Promise<void> {
    await this.client.remove(this.abs(remotePath), ignoreMissing);
  }

  async removeDir(remotePath: string): Promise<void> {
    await this.client.removeDir(this.abs(remotePath));
  }

  private abs(rel: string): string {
    return posix.join(this.cfg.remoteRoot, rel);
  }
}

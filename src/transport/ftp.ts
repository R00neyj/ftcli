import { Client } from "basic-ftp";
import { mkdir } from "node:fs/promises";
import path, { posix } from "node:path";
import type { Config } from "../config.js";
import type { RemoteEntry, Transport } from "./types.js";

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
          out.push({ path: itemRel, size: item.size, isDir: false });
        }
      }
    };
    await walk(dir);
    return out;
  }

  async upload(localPath: string, remotePath: string): Promise<void> {
    const abs = this.abs(remotePath);
    await this.client.ensureDir(posix.dirname(abs));
    await this.client.uploadFrom(localPath, abs);
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

  private abs(rel: string): string {
    return posix.join(this.cfg.remoteRoot, rel);
  }
}

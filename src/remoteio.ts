import { Writable } from "node:stream";
import type { Transport } from "./transport/types.js";
import { isPermanentReply } from "./transport/errors.js";

/** cat / head / tail / wc / sed 가 메모리로 받는 파일 크기 상한 */
export const TEXT_MAX_BYTES = 5 * 1024 * 1024;

const BINARY_PROBE = 8192;

export class SizeExceededError extends Error {
  /** 전송 도중 끊었으므로 이 연결은 재사용하지 않음 (mapPool 이 확인) */
  readonly discardConnection = true;

  constructor(readonly maxSize: number) {
    super(`크기 초과: ${maxSize}바이트 한도 넘음`);
  }
}

/** 원격 파일을 maxSize 까지 메모리로 받음. 넘으면 SizeExceededError */
export async function fetchBuffer(
  download: (dest: Writable) => Promise<void>,
  maxSize: number,
): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  let exceeded = false;
  const sink = new Writable({
    write(chunk: Buffer, _enc, cb) {
      total += chunk.length;
      if (total > maxSize) {
        exceeded = true;
        cb(new SizeExceededError(maxSize));
        return;
      }
      chunks.push(chunk);
      cb();
    },
  });
  try {
    await download(sink);
  } catch (err) {
    if (exceeded) throw new SizeExceededError(maxSize);
    throw err;
  }
  if (exceeded) throw new SizeExceededError(maxSize);
  return Buffer.concat(chunks);
}

export const isBinary = (buf: Buffer): boolean => buf.subarray(0, BINARY_PROBE).includes(0);

/** 텍스트 명령용: 상한(기본 5MB, forceLarge 시 무제한)까지 받음. 없는 파일은 읽기 쉬운 메시지로 바꿈 */
export async function readRemoteFile(t: Transport, rel: string, forceLarge = false): Promise<Buffer> {
  const max = forceLarge ? Number.POSITIVE_INFINITY : TEXT_MAX_BYTES;
  try {
    return await fetchBuffer((dest) => t.downloadToStream(rel, dest), max);
  } catch (err) {
    if (err instanceof SizeExceededError) {
      const e = new SizeExceededError(max);
      e.message = "5MB 초과, --force-large 필요함";
      throw e;
    }
    if (isPermanentReply(err)) {
      throw new Error(`원격에 없거나 파일이 아님 (${err instanceof Error ? err.message : String(err)})`);
    }
    throw err;
  }
}

const strictUtf8 = new TextDecoder("utf-8", { fatal: true });

/** UTF-8 로 올바르게 해석되는지 (EUC-KR/CP949 등은 false). utf8 로 디코딩 후 다시 인코딩해도 바이트가 그대로인지 판단용 */
export function isUtf8(buf: Buffer): boolean {
  try {
    strictUtf8.decode(buf);
    return true;
  } catch {
    return false;
  }
}

/** 줄 단위 처리용 분할. 마지막 줄바꿈 유무를 보존해 join 시 원래 형태로 되돌릴 수 있게 함 */
export function splitLines(text: string): { lines: string[]; trailingNewline: boolean } {
  if (text === "") return { lines: [], trailingNewline: false };
  const trailingNewline = text.endsWith("\n");
  const lines = (trailingNewline ? text.slice(0, -1) : text).split("\n");
  return { lines, trailingNewline };
}

export const joinLines = (lines: string[], trailingNewline: boolean): string =>
  lines.length === 0 ? "" : lines.join("\n") + (trailingNewline ? "\n" : "");

/** stdout 이 닫힌 경우(`| head` 등) EPIPE 로 프로세스가 죽지 않게 무시함 */
export function ignoreStdoutEpipe(): void {
  process.stdout.on("error", (err: NodeJS.ErrnoException) => {
    if (err.code === "EPIPE" || err.code === "ERR_STREAM_DESTROYED") return;
    throw err;
  });
}

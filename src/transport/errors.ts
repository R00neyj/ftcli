import { FTPError } from "basic-ftp";

const TRANSIENT_CODES = new Set([421, 425, 426, 450, 451, 452]);
const TRANSIENT_MESSAGE = /timeout|timed out|ECONNRESET|EPIPE|ETIMEDOUT|socket|closed/i;

export function isAuthError(err: unknown): boolean {
  return err instanceof FTPError && err.code === 530;
}

export function isTransient(err: unknown): boolean {
  if (err instanceof FTPError) return TRANSIENT_CODES.has(err.code);
  return TRANSIENT_MESSAGE.test(err instanceof Error ? err.message : String(err));
}

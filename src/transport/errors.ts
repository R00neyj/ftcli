import { FTPError } from "basic-ftp";

const TRANSIENT_CODES = new Set([421, 425, 426, 450, 451, 452]);
const TRANSIENT_MESSAGE = /timeout|timed out|ECONNRESET|EPIPE|ETIMEDOUT|socket|closed/i;

export class LoginBudgetError extends Error {}

export function isFatal(err: unknown): boolean {
  return isAuthError(err) || err instanceof LoginBudgetError;
}

export function isAuthError(err: unknown): boolean {
  return err instanceof FTPError && err.code === 530;
}

export function isTransient(err: unknown): boolean {
  if (err instanceof FTPError) return TRANSIENT_CODES.has(err.code);
  return TRANSIENT_MESSAGE.test(err instanceof Error ? err.message : String(err));
}

const CONNECTION_CODES = new Set([421, 425, 426, 530]);

/** 서버가 요청 자체에 대해 확정 응답(예: 550)을 준 오류. 연결·인증 문제는 제외 */
export function isDefinitive(err: unknown): boolean {
  return err instanceof FTPError && !CONNECTION_CODES.has(err.code);
}

/** 재시도해도 결과가 같을 확정 응답 (일시적 4xx 제외). "없음" 으로 간주해도 되는 오류 */
export function isPermanentReply(err: unknown): boolean {
  return isDefinitive(err) && !isTransient(err);
}

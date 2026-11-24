import type { Command } from "commander";
import type { Context } from "./session.js";

export type RunFn = (cmd: Command, fn: (ctx: Context) => Promise<void>) => Promise<void>;
export type Register = (program: Command, run: RunFn) => void;

const intOption = (min: number, max: number) => (v: string) =>
  Math.min(max, Math.max(min, Number.parseInt(v, 10) || min));

export const jobsOption = ["-j, --jobs <n>", "병렬 연결 수 (1~4)", intOption(1, 4), 4] as const;
export const retriesOption = [
  "--retries <n>",
  "일시 오류 재시도 횟수 (0~5)",
  intOption(0, 5),
  1,
] as const;
export const intOpt = intOption;

export type RowAction =
  | "pulled"
  | "pushed"
  | "released"
  | "removed"
  | "skipped"
  | "planned"
  | "failed";

export interface ResultRow {
  path: string;
  action: RowAction;
  reason?: string;
}

export interface StatusRow {
  path: string;
  state: string;
}

export const printJson = (value: unknown): void => {
  process.stdout.write(`${JSON.stringify(value)}
`);
};

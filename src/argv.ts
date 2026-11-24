/**
 * commander 가 그대로 해석하지 못하는 bash 식 인자를 파싱 전에 바꿈
 * - find: -name / -iname / -path / -type / -maxdepth → --name ...,  -print 는 제거
 * - head / tail: -20 → -n 20
 * - grep / rg: -C 3 / -C3 → --context 3 (전역 옵션 -C(--cwd) 와 충돌 방지)
 * - sed: -i.bak / -i~ / --in-place=.bak / -i '' → -i (백업 이름은 항상 <경로>.bak)
 * 하위 명령 이전의 전역 옵션과 `--` 이후 인자는 건드리지 않음
 */

/** 값을 받는 전역 옵션 (공백으로 값 분리 시 다음 인자를 건너뜀) */
const GLOBAL_WITH_VALUE = new Set(["-C", "--cwd", "--password"]);

/** grep 에서 값을 받는 옵션 (공백으로 값 분리 시 다음 인자는 재작성하지 않음) */
const GREP_WITH_VALUE = new Set([
  "-e",
  "--regexp",
  "-A",
  "-B",
  "-m",
  "-g",
  "--glob",
  "--include",
  "--exclude",
  "--exclude-dir",
  "--max-size",
  "--context",
  "-j",
  "--jobs",
  "--retries",
]);

const ALIASES: Record<string, string> = {
  rg: "grep",
};

const FIND_PREDICATES: Record<string, string> = {
  "-name": "--name",
  "-iname": "--iname",
  "-path": "--path",
  "-type": "--type",
  "-maxdepth": "--maxdepth",
};

function commandIndex(args: string[]): number {
  for (let i = 0; i < args.length; i++) {
    const a = args[i] as string;
    if (a === "--") return -1;
    if (GLOBAL_WITH_VALUE.has(a)) {
      i++;
      continue;
    }
    if (a.startsWith("-")) continue;
    return i;
  }
  return -1;
}

function rewriteFor(cmd: string, rest: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i] as string;
    if (a === "--") {
      out.push(...rest.slice(i));
      break;
    }
    if (cmd === "find") {
      const mapped = FIND_PREDICATES[a];
      if (mapped) {
        out.push(mapped);
        continue;
      }
      if (a === "-print") continue;
    } else if (cmd === "head" || cmd === "tail") {
      const m = /^-(\d+)$/.exec(a);
      if (m) {
        out.push("-n", m[1] as string);
        continue;
      }
    } else if (cmd === "grep") {
      // 값을 받는 옵션은 값(다음 인자)을 그대로 통과 (예: -e -C)
      if (GREP_WITH_VALUE.has(a) && i + 1 < rest.length) {
        out.push(a, rest[i + 1] as string);
        i++;
        continue;
      }
      if (a === "-C") {
        out.push("--context");
        continue;
      }
      const m = /^-C(\d+)$/.exec(a);
      if (m) {
        out.push("--context", m[1] as string);
        continue;
      }
    } else if (cmd === "sed") {
      // macOS sed 습관: -i '' (백업 접미사 없음) 의 빈 인자는 버림
      // -Ei '' / -ni '' 처럼 짧은 옵션 묶음의 끝이 i 인 경우도 포함
      if (/^-[A-Za-z]*i$/.test(a) && rest[i + 1] === "") {
        out.push(a);
        i++;
        continue;
      }
      if (/^-i.+/.test(a) && !a.startsWith("-in")) {
        out.push("-i");
        continue;
      }
      if (a.startsWith("--in-place=")) {
        out.push("-i");
        continue;
      }
    }
    out.push(a);
  }
  return out;
}

/** process.argv.slice(2) 형태를 받아 바꾼 배열을 돌려줌 */
export function rewriteArgv(args: string[]): string[] {
  const idx = commandIndex(args);
  if (idx < 0) return args;
  const name = args[idx] as string;
  const cmd = ALIASES[name] ?? name;
  return [...args.slice(0, idx + 1), ...rewriteFor(cmd, args.slice(idx + 1))];
}

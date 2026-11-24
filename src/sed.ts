/**
 * 에이전트가 자주 쓰는 sed 부분집합
 * - 주소: N, $, /re/ (또는 \cREc), 범위 a1,a2, 부정 !
 * - 명령: p, d, q, s/re/rep/[g i I p]
 * - 여러 명령은 ; 줄바꿈 또는 -e 반복으로 구분
 * 정규식은 기본 BRE(기본 정규식, \( \) \{ \} \+ \? \| 가 특수 문자)이고 -E/-r 이면 ERE 로 해석해 JavaScript 정규식으로 바꿈
 */

type Addr = { kind: "line"; n: number } | { kind: "last" } | { kind: "re"; re: RegExp };

interface Subst {
  re: RegExp;
  rep: string;
  global: boolean;
  print: boolean;
}

export interface SedCmd {
  a1?: Addr;
  a2?: Addr;
  negate: boolean;
  op: "p" | "d" | "q" | "s";
  subst?: Subst;
}

export class SedError extends Error {}

const POSIX_CLASSES: Record<string, string> = {
  alpha: "a-zA-Z",
  digit: "0-9",
  alnum: "a-zA-Z0-9",
  upper: "A-Z",
  lower: "a-z",
  space: " \\t\\r\\n\\f\\v",
  blank: " \\t",
  punct: "!-\\/:-@\\[-`{-~",
  xdigit: "0-9A-Fa-f",
};

/** sed 정규식(BRE/ERE) → JavaScript 정규식 소스 */
export function toJsRegexSource(src: string, ere: boolean): string {
  let out = "";
  let inBracket = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i] as string;
    if (inBracket) {
      if (c === "[" && src[i + 1] === ":") {
        const end = src.indexOf(":]", i + 2);
        const name = end > 0 ? src.slice(i + 2, end) : "";
        const cls = POSIX_CLASSES[name];
        if (cls === undefined) throw new SedError(`지원하지 않는 문자 클래스: [:${name}:]`);
        out += cls;
        i = end + 1;
        continue;
      }
      if (c === "]" && !(out.endsWith("[") || out.endsWith("[^"))) inBracket = false;
      if (c === "\\") out += "\\\\";
      else out += c;
      continue;
    }
    if (c === "[") {
      inBracket = true;
      out += c;
      if (src[i + 1] === "^") {
        out += "^";
        i++;
      }
      if (src[i + 1] === "]") {
        out += "\\]";
        i++;
      }
      continue;
    }
    if (c === "\\") {
      const n = src[i + 1];
      i++;
      if (n === undefined) throw new SedError("정규식이 \\ 로 끝남");
      if (n === "<" || n === ">") out += "\\b";
      else if (!ere && "(){}+?|".includes(n)) out += n;
      else if (ere && "(){}+?|".includes(n)) out += `\\${n}`;
      else out += `\\${n}`;
      continue;
    }
    if (!ere && "(){}+?|".includes(c)) {
      out += `\\${c}`;
      continue;
    }
    out += c;
  }
  if (inBracket) throw new SedError("[ 가 닫히지 않음");
  return out;
}

/** sed 치환 문자열 → String.replace 치환 문자열 */
export function toJsReplacement(rep: string): string {
  let out = "";
  for (let i = 0; i < rep.length; i++) {
    const c = rep[i] as string;
    if (c === "\\") {
      const n = rep[i + 1];
      i++;
      if (n === undefined) out += "\\";
      else if (/[0-9]/.test(n)) out += n === "0" ? "$&" : `$${n}`;
      else if (n === "n") out += "\n";
      else if (n === "t") out += "\t";
      else if (n === "$") out += "$$";
      else out += n;
    } else if (c === "&") {
      out += "$&";
    } else if (c === "$") {
      out += "$$";
    } else {
      out += c;
    }
  }
  return out;
}

class Reader {
  i = 0;
  constructor(readonly s: string) {}
  peek(): string | undefined {
    return this.s[this.i];
  }
  next(): string | undefined {
    return this.s[this.i++];
  }
  eof(): boolean {
    return this.i >= this.s.length;
  }
  skipSpace(): void {
    while (!this.eof() && /[ \t]/.test(this.peek() as string)) this.i++;
  }
  /** 구분자 delim 까지 읽음. \delim 은 delim 문자 자체로, 나머지 이스케이프는 그대로 유지 */
  until(delim: string, what: string): string {
    let out = "";
    for (;;) {
      const c = this.next();
      if (c === undefined) throw new SedError(`${what} 가 ${delim} 로 끝나지 않음`);
      if (c === delim) return out;
      if (c === "\\") {
        const n = this.next();
        if (n === undefined) throw new SedError(`${what} 가 \\ 로 끝남`);
        if (n === delim) out += delim;
        else if (n === "n" && what !== "치환 문자열") out += "\\n";
        else out += `\\${n}`;
      } else {
        out += c;
      }
    }
  }
}

function makeRegex(src: string, ere: boolean, flags: string): RegExp {
  try {
    return new RegExp(toJsRegexSource(src, ere), flags);
  } catch (err) {
    if (err instanceof SedError) throw err;
    throw new SedError(`정규식 오류: ${src} (${err instanceof Error ? err.message : String(err)})`);
  }
}

function parseAddr(r: Reader, ere: boolean): Addr | undefined {
  const c = r.peek();
  if (c === undefined) return undefined;
  if (/[0-9]/.test(c)) {
    let num = "";
    while (!r.eof() && /[0-9]/.test(r.peek() as string)) num += r.next();
    const n = Number(num);
    if (n === 0) throw new SedError("줄 번호는 1부터 시작함");
    return { kind: "line", n };
  }
  if (c === "$") {
    r.next();
    return { kind: "last" };
  }
  if (c === "/" || c === "\\") {
    r.next();
    const delim = c === "/" ? "/" : r.next();
    if (delim === undefined) throw new SedError("주소 구분자 없음");
    const src = r.until(delim, "주소 정규식");
    if (src === "") throw new SedError("빈 정규식(직전 정규식 재사용)은 지원하지 않음");
    let flags = "";
    if (r.peek() === "I") {
      r.next();
      flags = "i";
    }
    return { kind: "re", re: makeRegex(src, ere, flags) };
  }
  return undefined;
}

export function parseSed(scripts: string[], ere: boolean): SedCmd[] {
  const cmds: SedCmd[] = [];
  for (const script of scripts) {
    const r = new Reader(script);
    for (;;) {
      while (!r.eof() && /[\s;]/.test(r.peek() as string)) r.next();
      if (r.eof()) break;
      const a1 = parseAddr(r, ere);
      let a2: Addr | undefined;
      if (a1 && r.peek() === ",") {
        r.next();
        a2 = parseAddr(r, ere);
        if (!a2) throw new SedError("범위 끝 주소가 잘못됨");
      }
      r.skipSpace();
      let negate = false;
      if (r.peek() === "!") {
        r.next();
        negate = true;
        r.skipSpace();
      }
      const op = r.next();
      if (op === undefined) throw new SedError("명령 없음");
      if (op === "p" || op === "d" || op === "q") {
        if (op === "q" && a2) throw new SedError("q 는 범위 주소를 받지 않음");
        cmds.push({ a1, a2, negate, op });
      } else if (op === "s") {
        const delim = r.next();
        if (delim === undefined || delim === "\\" || delim === "\n") throw new SedError("s 구분자가 잘못됨");
        const src = r.until(delim, "정규식");
        const rep = r.until(delim, "치환 문자열");
        let global = false;
        let print = false;
        let flags = "";
        while (!r.eof() && /[gGiIpm]/.test(r.peek() as string)) {
          const f = r.next();
          if (f === "g" || f === "G") global = true;
          else if (f === "i" || f === "I") flags += "i";
          else if (f === "p") print = true;
        }
        if (!r.eof() && /[0-9]/.test(r.peek() as string)) {
          throw new SedError("s 의 n번째 일치 플래그는 지원하지 않음");
        }
        if (src === "") throw new SedError("빈 정규식(직전 정규식 재사용)은 지원하지 않음");
        cmds.push({
          a1,
          a2,
          negate,
          op: "s",
          subst: { re: makeRegex(src, ere, `${global ? "g" : ""}${flags}`), rep: toJsReplacement(rep), global, print },
        });
      } else {
        throw new SedError(`지원하지 않는 sed 명령: ${op} (p, d, q, s 만 지원)`);
      }
      r.skipSpace();
      const sep = r.peek();
      if (sep !== undefined && sep !== ";" && sep !== "\n" && sep !== "}") {
        throw new SedError(`명령 뒤에 알 수 없는 문자: ${sep}`);
      }
      if (sep === "}") throw new SedError("{ } 블록은 지원하지 않음");
    }
  }
  if (cmds.length === 0) throw new SedError("sed 스크립트가 비어 있음");
  return cmds;
}

function matchAddr(a: Addr, lineNo: number, isLast: boolean, text: string): boolean {
  if (a.kind === "line") return lineNo === a.n;
  if (a.kind === "last") return isLast;
  a.re.lastIndex = 0;
  return a.re.test(text);
}

export interface SedResult {
  out: string[];
  /** 패턴 공간이 바뀐 줄 수 (s 로 실제 치환이 일어난 줄) */
  changedLines: number;
  /** d 로 지운 줄 수 */
  deletedLines: number;
  /** 마지막 출력이 입력의 마지막 줄에서 나왔는지. 원본에 끝 줄바꿈이 없으면 이 출력에만 줄바꿈을 붙이지 않음 */
  endsAtLastLine: boolean;
}

/** lines 각 줄 끝의 \r 은 처리 전에 떼고 출력 시 되돌려 CRLF 파일에서도 $ 가 기대대로 동작하게 함 */
export function runSed(cmds: SedCmd[], lines: string[], quiet: boolean): SedResult {
  const active = cmds.map(() => false);
  const out: string[] = [];
  let changedLines = 0;
  let deletedLines = 0;
  let lastLineOutStart = Number.POSITIVE_INFINITY;

  const selected = (k: number, cmd: SedCmd, lineNo: number, isLast: boolean, text: string): boolean => {
    let hit: boolean;
    if (!cmd.a1) hit = true;
    else if (!cmd.a2) hit = matchAddr(cmd.a1, lineNo, isLast, text);
    else if (active[k]) {
      hit = true;
      const a2 = cmd.a2;
      if (a2.kind === "line") {
        if (lineNo >= a2.n) active[k] = false;
      } else if (matchAddr(a2, lineNo, isLast, text)) active[k] = false;
    } else if (matchAddr(cmd.a1, lineNo, isLast, text)) {
      hit = true;
      const a2 = cmd.a2;
      // GNU sed: 끝 주소가 줄 번호이고 시작 줄 이하이면 한 줄만 선택
      if (a2.kind === "line") active[k] = a2.n > lineNo;
      else if (a2.kind === "last") active[k] = !isLast;
      else active[k] = true;
    } else hit = false;
    return cmd.negate ? !hit : hit;
  };

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i] as string;
    const cr = raw.endsWith("\r");
    let text = cr ? raw.slice(0, -1) : raw;
    const lineNo = i + 1;
    const isLast = i === lines.length - 1;
    if (isLast) lastLineOutStart = out.length;
    let deleted = false;
    let quit = false;
    let changed = false;
    for (let k = 0; k < cmds.length; k++) {
      const cmd = cmds[k] as SedCmd;
      if (!selected(k, cmd, lineNo, isLast, text)) continue;
      if (cmd.op === "p") out.push(text + (cr ? "\r" : ""));
      else if (cmd.op === "d") {
        deleted = true;
        break;
      } else if (cmd.op === "q") {
        quit = true;
        break;
      } else if (cmd.subst) {
        const { re, rep, print } = cmd.subst;
        re.lastIndex = 0;
        if (re.test(text)) {
          re.lastIndex = 0;
          text = text.replace(re, rep);
          changed = true;
          if (print) out.push(text + (cr ? "\r" : ""));
        }
      }
    }
    if (changed) changedLines++;
    if (deleted) {
      deletedLines++;
      continue;
    }
    if (!quiet) out.push(text + (cr ? "\r" : ""));
    if (quit) break;
  }
  return { out, changedLines, deletedLines, endsAtLastLine: out.length > lastLineOutStart };
}

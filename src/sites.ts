// 담당자 문서(CSV / Markdown)에서 사이트별 FTP 접속 정보를 뽑아냄. 형식이 사람마다 달라 열·키 이름은 별칭으로 맞춤

export type Field = "dir" | "host" | "port" | "user" | "password" | "secure" | "remoteRoot";

export interface SiteRecord {
  /** 원문 위치 (`파일:줄`) */
  source: string;
  values: Partial<Record<Field, string>>;
  /** 같은 사이트 안에서 서로 다른 값이 나온 필드. 어느 쪽이 맞는지 모르므로 가져오지 않음 */
  conflicts: Field[];
}

interface Row {
  cells: string[];
  line: number;
}

const ALIASES: Record<string, Field> = {};
const alias = (field: Field, ...keys: string[]): void => {
  for (const k of keys) ALIASES[k] = field;
};
alias("dir", "dir", "folder", "폴더", "로컬폴더", "로컬경로", "localdir", "project", "프로젝트", "프로젝트명", "site", "사이트", "사이트명");
alias("host", "host", "hostname", "server", "호스트", "서버", "서버주소", "접속주소");
alias("port", "port", "포트");
alias("user", "user", "username", "userid", "id", "아이디", "사용자");
alias("password", "password", "passwd", "pass", "pw", "pwd", "비밀번호", "비번", "패스워드", "암호");
alias("secure", "secure", "ftps", "tls", "보안");
alias("remoteRoot", "remoteroot", "remotedir", "remotepath", "원격경로", "원격폴더", "웹루트", "webroot", "업로드경로", "root", "루트");
/** 단독으로는 뜻이 넓어 `FTP` 접두어가 붙었을 때만 인정 (`FTP 주소`, `FTP 계정`) */
const FTP_ONLY: Record<string, Field> = { 주소: "host", 계정: "user" };

const normKey = (key: string): string =>
  key
    .normalize("NFC")
    .toLowerCase()
    .replace(/[\s_\-.:*`()[\]]/g, "");

export function fieldOf(key: string): Field | undefined {
  const k = normKey(key);
  const direct = ALIASES[k];
  if (direct) return direct;
  if (!k.startsWith("ftp") || k.length === 3) return undefined;
  const rest = k.slice(3);
  return ALIASES[rest] ?? FTP_ONLY[rest];
}

const WRAPPERS: [string, string][] = [
  ["`", "`"],
  ["**", "**"],
  ["<", ">"],
];

function cleanValue(v: string): string {
  let s = v.trim();
  for (const [open, close] of WRAPPERS) {
    if (s.length > open.length + close.length && s.startsWith(open) && s.endsWith(close)) {
      s = s.slice(open.length, -close.length).trim();
    }
  }
  return s;
}

class Builder {
  private rec: SiteRecord;
  constructor(source: string) {
    this.rec = { source, values: {}, conflicts: [] };
  }
  set(field: Field, raw: string): void {
    const value = cleanValue(raw);
    if (!value) return;
    const prev = this.rec.values[field];
    if (prev === undefined) this.rec.values[field] = value;
    else if (prev !== value && !this.rec.conflicts.includes(field)) this.rec.conflicts.push(field);
  }
  /** 접속 정보가 하나도 없으면(일반 섹션·빈 행) 버림 */
  done(): SiteRecord | undefined {
    const v = this.rec.values;
    return v.user || v.password || v.host ? this.rec : undefined;
  }
}

/** 헤더 행 + 사이트별 행 표. dir 열과 다른 접속 정보 열이 함께 있어야 사이트 표로 인정 */
function rowTable(rows: Row[], file: string): SiteRecord[] | undefined {
  const [head, ...body] = rows;
  if (!head) return undefined;
  const header = head.cells.map(fieldOf);
  if (!header.includes("dir") || header.filter(Boolean).length < 2) return undefined;
  const out: SiteRecord[] = [];
  for (const row of body) {
    const b = new Builder(`${file}:${row.line}`);
    row.cells.forEach((cell, c) => {
      const f = header[c];
      if (f) b.set(f, cell);
    });
    const rec = b.done();
    if (rec) out.push(rec);
  }
  return out;
}

// ---- CSV ----

export function parseCsvRows(text: string): Row[] {
  const rows: Row[] = [];
  let cells: string[] = [];
  let cell = "";
  let quoted = false;
  let line = 1;
  let rowLine = 1;
  const endRow = (): void => {
    cells.push(cell);
    if (cells.some((c) => c.trim() !== "")) rows.push({ cells, line: rowLine });
    cells = [];
    cell = "";
  };
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else {
        if (ch === "\n") line++;
        cell += ch;
      }
    } else if (ch === '"' && cell.trim() === "") {
      cell = "";
      quoted = true;
    } else if (ch === ",") {
      cells.push(cell);
      cell = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      endRow();
      line++;
      rowLine = line;
    } else cell += ch;
  }
  if (cell !== "" || cells.length > 0) endRow();
  return rows;
}

export function parseCsv(text: string, file: string): SiteRecord[] {
  const rows = parseCsvRows(text);
  if (rows.length === 0) return [];
  const recs = rowTable(rows, file);
  if (!recs) throw new Error(`${file}: 헤더에 폴더(dir) 열과 접속 정보 열이 필요함`);
  return recs;
}

// ---- Markdown ----

/** 프로젝트 이름이 아닌 하위 제목. 이런 제목 아래 정보는 상위 제목의 사이트로 봄 */
const GENERIC_HEADINGS = new Set(
  ["ftp", "ftp정보", "ftp접속정보", "접속정보", "서버", "서버정보", "계정", "계정정보", "참고사항", "정보", "호스팅", "호스팅정보"].map(normKey),
);

function splitTableRow(line: string): string[] {
  let s = line.trim();
  if (s.startsWith("|")) s = s.slice(1);
  if (s.endsWith("|") && !s.endsWith("\\|")) s = s.slice(0, -1);
  return s.split(/(?<!\\)\|/).map((c) => c.replace(/\\\|/g, "|").trim());
}

const KV_LINE = /^\s*(?:[-*+]\s+)?([^:：|]+?)\s*[:：]\s*(.*)$/;
const FENCE = /^\s*(```|~~~)/;
const HEADING = /^(#{1,6})\s+(.+?)\s*#*\s*$/;

export function parseMarkdown(text: string, file: string): SiteRecord[] {
  const lines = text.split(/\r?\n/);
  const out: SiteRecord[] = [];
  const headings: { level: number; text: string }[] = [];
  let section: Builder | undefined;
  let sectionDir: string | undefined;
  let inFence = false;

  const closeSection = (): void => {
    const rec = section?.done();
    if (rec) {
      rec.values.dir ??= sectionDir;
      out.push(rec);
    }
    section = undefined;
  };
  const sectionSet = (lineNo: number, f: Field, value: string): void => {
    section ??= new Builder(`${file}:${lineNo}`);
    section.set(f, value);
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (FENCE.test(line)) {
      inFence = !inFence;
      continue;
    }
    const h = inFence ? null : HEADING.exec(line);
    if (h) {
      closeSection();
      const level = (h[1] ?? "").length;
      while ((headings.at(-1)?.level ?? 0) >= level) headings.pop();
      headings.push({ level, text: cleanValue(h[2] ?? "") });
      sectionDir = [...headings].reverse().find((x) => !GENERIC_HEADINGS.has(normKey(x.text)))?.text;
      continue;
    }
    if (!inFence && line.trim().startsWith("|")) {
      const start = i + 1;
      const rows: Row[] = [];
      for (; i < lines.length && (lines[i] ?? "").trim().startsWith("|"); i++) {
        const cells = splitTableRow(lines[i] ?? "");
        if (!cells.every((c) => /^:?-+:?$/.test(c))) rows.push({ cells, line: i + 1 });
      }
      i--;
      const recs = rowTable(rows, file);
      if (recs) {
        out.push(...recs);
        continue;
      }
      // 2열 키-값 표: 첫 행도 데이터일 수 있으므로(Obsidian 노트 등) 모든 행을 키-값으로 읽음
      for (const { cells } of rows) {
        const [key, value] = cells;
        const f = key !== undefined && value !== undefined ? fieldOf(key) : undefined;
        if (f && value !== undefined) sectionSet(start, f, value);
      }
      continue;
    }
    const kv = KV_LINE.exec(line);
    const f = kv ? fieldOf((kv[1] ?? "").replace(/^\*\*|\*\*$/g, "")) : undefined;
    if (f) sectionSet(i + 1, f, kv?.[2] ?? "");
  }
  closeSection();
  return out;
}

/** Excel 한국어판의 CSV 기본 저장 인코딩은 CP949 라서 UTF-8 이 아니면 EUC-KR 로 읽음 */
export function decodeText(buf: Uint8Array): string {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(buf);
  } catch {
    text = new TextDecoder("euc-kr").decode(buf);
  }
  return text.replace(/^\uFEFF/, "");
}

export function parseSites(text: string, file: string): SiteRecord[] {
  return /\.csv$/i.test(file) ? parseCsv(text, file) : parseMarkdown(text, file);
}

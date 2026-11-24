# ftcli

FTP 목록 / 로컬 diff / 업로드 / 다운로드 / 백업 CLI + 작업 집합(원격 SSOT) 모드. Node + TypeScript, 전송은 [basic-ftp](https://github.com/patrickjuchli/basic-ftp).

## 설치

Node 20 이상 필요. [Releases](https://github.com/R00neyj/ftcli/releases) 의 tgz 로 전역 설치함.

```sh
npm i -g https://github.com/R00neyj/ftcli/releases/latest/download/ftcli.tgz           # 최신
npm i -g https://github.com/R00neyj/ftcli/releases/download/v0.1.0/ftcli-0.1.0.tgz     # 버전 고정
ftcli --help
```

업데이트는 같은 명령 재실행. `npm i -g github:R00neyj/ftcli` 는 npm 이 git 의존성을 전역 설치할 때 devDependencies 없이 `prepare` 를 돌려 `tsc` 를 못 찾고 실패하므로 쓰지 않음.

### 개발

```sh
npm install            # prepare 가 dist 빌드
npm link               # 전역 ftcli 를 이 폴더에 연결 (폴더 삭제 시 깨짐)
npm run dev -- <명령>
```

### 릴리스

`package.json` 의 `version` 을 올려 커밋한 뒤 같은 버전의 `v` 태그를 push 하면 GitHub Actions(`.github/workflows/release.yml`)가 typecheck → `npm pack` → 설치 확인 후 Release 에 `ftcli-<버전>.tgz` 와 `ftcli.tgz` 를 첨부함. 태그와 `version` 이 다르면 실패함.

```sh
npm version patch      # version 수정 + 커밋 + v 태그 생성
git push --follow-tags
```

## 설정

`ftcli init` → `.ftcli/config.json` 생성 후 수정. 함께 생성되는 `.ftcli/.gitignore`(`*`)가 설정(평문 비밀번호 포함)·백업·인덱스를 git 커밋 대상에서 제외함.

```json
{ "protocol": "ftp", "host": "example.com", "port": 21, "user": "user", "password": "", "secure": false, "remoteRoot": "/" }
```

비밀번호 우선순위: `--password` → `FTPCLI_PASSWORD` 환경 변수 → `config.password`.

무시 규칙: `.ftignore` 또는 `.ftpignore` (`.gitignore` 문법). `.ftcli`, `.git` 은 항상 제외.

### 여러 프로젝트 일괄 설정 (`import`)

담당자 문서(CSV / Markdown)에 적힌 접속 정보로 프로젝트 폴더마다 `.ftcli/config.json`(+ `.gitignore`)을 만듦. 폴더 경로는 `-C` 기준(기본: 현재 디렉터리) 상대 경로임.

```sh
ftcli import -C D:/작업물 ftp.md -n                  # 결과만 미리 보기
ftcli import -C D:/작업물 ftp.md sites.csv notes/*.md  # 실제 생성
ftcli import -C D:/작업물 ftp.md --host "{user}.example.com" --remote-root /www
```

읽는 형식:

| 형식 | 사이트 구분 | 폴더 |
|---|---|---|
| CSV (`.csv`, UTF-8 / EUC-KR) | 행 하나 = 사이트 하나 | `폴더`·`프로젝트`·`사이트명` 등 열 |
| Markdown 표 (헤더에 폴더 열 있음) | 행 하나 = 사이트 하나 | 폴더 열 |
| Markdown 제목 섹션 | 제목 하나 = 사이트 하나. 섹션 안의 `키: 값` 줄(목록·코드 블록 포함)과 2열 표를 읽음 | 제목 텍스트. `FTP`, `접속정보`, `참고사항` 같은 하위 제목은 상위 제목을 씀 |

- 키·열 이름은 별칭으로 맞춤: host(`호스트`, `서버`, `FTP 주소`), user(`아이디`, `ID`, `FTP 계정`), password(`비밀번호`, `비번`, `PW`), port(`포트`), remoteRoot(`원격경로`, `웹루트`), secure(`ftps`, `보안`). 앞에 `FTP` 가 붙어도 됨. `ftp://host:port` 형식의 host 도 읽음
- 문서에 없는 host / port / secure / remoteRoot 는 `--host`(`{user}` 를 계정명으로 바꿈) / `--port` / `--secure` / `--remote-root` 값으로 채움
- 건너뛰는 경우: 로컬 폴더가 없음, user·password·host 가 없음, 같은 사이트에서 같은 키의 값이 서로 다름, 같은 폴더가 두 번 이상 나옴. 실패가 하나라도 있으면 종료 코드 `2`
- 이미 `config.json` 이 있는 폴더는 그대로 두고, `--force` 를 주면 갱신함. 이때 문서에 없는 기존 값(`maxLogins` 등)은 유지함
- 출력에 비밀번호는 표시하지 않음

## 인증 실패 잠금

`530`(인증 실패)이 한 번 나면 `.ftcli/auth-lock.json` 에 계정·비밀번호 지문만 기록하고, 같은 자격으로는 이후 접속하지 않고 즉시 실패함. 에이전트가 틀린 비밀번호로 명령을 반복 호출해 서버가 IP 를 차단하는 것을 막기 위함. 비밀번호를 바꾸면 자동 해제, 같은 비밀번호로 확인하려면 `--retry-auth`(1회). 성공적으로 접속하면 기록이 지워짐.

### 로그인 횟수 상한

한 명령이 서버에 로그인하는 횟수를 최대 10회로 제한함(`config.json` 의 `maxLogins` 로 조정). 병렬 연결 4개 + 재연결 6회 분량이며, 초과하면 서버 IP 차단을 막기 위해 즉시 중단함. 로그인 시도 사이에는 250ms 간격을 둠.

## 명령

| 명령 | 설명 |
|---|---|
| `ls [dir] [-r]` (별칭 `dir`) | 원격 목록 |
| `diff [files...] [--verify]` | 로컬 vs 원격 (`+` 로컬만 / `-` 원격만 / `M` 다름). 기본은 크기 비교, `--verify` 는 해시 비교 |
| `upload [files...] [-n] [--no-backup]` | `+`/`M` 업로드. 덮어쓰기 전 원격에 `<file>.bak` 생성 |
| `download [files...] [-n] [--no-backup]` | `-`/`M` 다운로드. 덮어쓰는 로컬 파일은 `.ftcli/backups/<시각>/` 로 보관 |
| `backup [paths...]` | 원격 파일을 `.ftcli/backups/<시각>/` 로 내려받음 |
| `rm <paths...> [-r] [-n] [-f] [--no-backup]` (별칭 `del`) | 원격 파일/디렉터리 삭제. 기본 `<경로>.bak` 으로 이동(기존 `.bak` 은 새 백업 이동이 끝난 뒤 삭제, 이동 실패 시 복원), `--no-backup` 시 완전 삭제. 작업 집합에 등록된 파일은 원격 변경 시 거부(`-f` 로 무시), 삭제 후 `state.json` 에서만 제거(로컬 파일 유지) |

공통 옵션: `-C, --cwd <dir>`, `--password <pw>`. 종료 코드: `0` 성공 / `1` 오류 / `2` 일부 파일 실패.

## 병렬 전송

`upload`, `download`, `backup` 에서 사용.

| 옵션 | 설명 |
|---|---|
| `-j, --jobs <n>` | 병렬 연결 수, 기본 4, 최대 4. 공유호스팅은 동시 접속 한도가 낮아 `421` 이 나면 병렬도를 자동으로 줄임. 계속 나면 `-j 2` 로 고정 |
| `--retries <n>` | 일시 오류(`421/425/426/450/451/452`, 타임아웃, 연결 끊김) 재시도 횟수, 기본 1 |

- 추가 연결이 `421` 등으로 실패하면 병렬도를 줄이고 계속 진행함. `530`(인증 실패)은 로그인 반복 시도를 막기 위해 전체 중단함.
- 전송 후 크기를 검증함. 업로드가 틀리면 원격 `.bak` 으로 복원하고, 다운로드는 `.ftcli-part` 임시 파일로 받아 크기가 맞을 때만 확정함.
- 새 폴더는 병렬 전송 전에 먼저 한 번에 만들어 둠.

## 작업 집합 모드 (원격이 SSOT)

로컬에 프로젝트 전체를 두지 않고 필요한 파일만 `pull` → 수정 → `push` 함. 받은 시점의 기준(base: 크기·MDTM·sha256)을 `.ftcli/state.json` 에 기록해 원격이 그 사이 바뀌었으면 push 를 거부함. 에이전트용으로 대부분 `--json` 지원 (JSON 은 stdout, 로그는 stderr).

| 명령 | 설명 |
|---|---|
| `find <패턴>` / `index` | 원격 경로 검색용 캐시(`.ftcli/index.json`) 구축·조회. glob(`**`,`*`,`?`) / 부분 문자열 / `--regex`. bash 식 `find [경로...] -name/-iname/-path/-type/-maxdepth` 도 가능 |
| `grep <패턴> [경로...]` (별칭 `rg`) | 원격 내용 검색. 디스크 저장 없이 메모리로 받아 검색. `-F -i -w -v -c -l -m -A -B -C -g/--glob --max-size` |
| `cat <경로...>` (별칭 `type`) | 다운로드 없이 stdout 출력 (5MB 초과는 `--force-large`) |
| `pull <경로...>` | 선택한 파일/디렉터리만 받고 base 기록. 로컬 수정분은 `--force` 없이는 보호 |
| `status [경로...]` | 작업 집합 상태. `M` 로컬 수정 / `R` 원격 변경 / `C` 충돌 / `!` 로컬 없음 / `D` 원격 삭제. 전체 LIST 없이 파일별 SIZE/MDTM 만 조회 |
| `push [파일...]` | 로컬 수정분 업로드. 원격이 base 와 다르면 거부(`--force` 로 무시). 덮어쓰기 전 원격 `.bak`, 업로드 후 크기 검증과 base 갱신. 작업 집합에 없는 명시 경로는 원격에 없을 때만 신규 업로드 |
| `release [경로...]` | 변경 없는 작업 집합 파일을 로컬에서 삭제해 공간 회수. 수정본·원격에서 삭제된 파일·원격이 바뀐 파일은 `--force` 필요 |
| `prune` | `.ftcli/backups` 정리 (`--keep n`, `--days n`, `--parts`) |

```sh
ftcli find "**/header*.php"
ftcli grep -i "define(.DB_HOST" wp-config.php
ftcli pull theme/header.php
# 수정
ftcli status
ftcli push theme/header.php
ftcli release
```

종료 코드: `0` 성공 / `1` 오류 / `2` 일부 실패·거부.

### 한계

- 변경 감지는 크기 + MDTM. 초 단위 MDTM 서버에서 같은 초·같은 크기의 외부 수정은 못 잡음. MDTM 이 없으면 push 시 원격을 해시로 비교함.
- 원격 `.bak` 은 1세대, `push` 는 파일 단위 가드(원자적 다중 파일 트랜잭션 아님).
- `grep` 은 FTP 에 서버측 검색이 없어 후보 파일을 모두 내려받아 검사하므로 `paths`/`--glob` 로 좁히는 편이 좋음.
- 인덱스는 `ftcli index` / `find --refresh` 시점의 스냅샷.

## bash 식 명령 (에이전트용)

에이전트가 셸에서 쓰던 습관대로 원격을 다룰 수 있게 같은 이름·옵션을 지원함. 파일 내용은 메모리로 받아 처리하며 5MB 초과 파일은 `--force-large` 필요.

| 명령 | 설명 |
|---|---|
| `ls [dir] [-R/--recursive] [-r] [-t] [-l] [-a] [-h]` | 원격 목록. `-t` 최근 수정 순. `-r` 은 `-t` / `-l` 과 함께 쓰면 역순(`ls -ltr` = 오래된 순, 하위 포함 안 함), 단독으로 쓰면 하위 포함(이전 동작 유지). 하위 포함은 `-R` 권장. `-l` `-a` `-h` 는 호환용(항상 상세·숨김 포함, 크기는 바이트). `ls -lh` 가 도움말로 빠지지 않게 ls 의 도움말은 `--help` 만 |
| `tree [dir] [-L n] [-d] [-a]` | 디렉터리 트리 |
| `head [-n N / -N] [-c N] <경로...>` | 앞부분 (기본 10줄) |
| `tail [-n N / -n +N / -N] [-c N] <경로...>` | 끝부분, `+N` 은 N번째 줄부터 |
| `wc [-l -w -c -m] <경로...>` | 줄·단어·바이트·문자 수 |
| `sed [-n] [-E/-r] [-e 스크립트]... <스크립트> <경로...>` | 결과를 stdout 으로 출력. 명령 `p d q s///[gIp]`, 주소 `N` `$` `/re/` `a,b` `!`. 기본 BRE, `-E` 는 ERE |
| `stat <경로...>` | 종류·크기·수정 시각 |
| `pwd` | `remoteRoot` 출력 (접속 안 함) |
| `grep` / `rg`, `find`, `cat` | 위 작업 집합 모드 표 참고. `grep` 은 `-e`(반복), `--include` / `--exclude` / `--exclude-dir` 도 받음. `-g '!*.min.js'` 처럼 `!` 로 시작하는 glob 은 제외. `--exclude-dir` 는 이름(`node_modules`)이나 경로(`wp-content/uploads`), 끝의 `/` 는 무시. `-h` 는 파일 경로 생략(`줄:내용`), grep 의 도움말은 `--help` 만. `-n -r -R -H -E -I` 는 호환용으로 받기만 함. `cat -n` 은 줄 번호(바이트 그대로, 여러 파일은 한 연결로 차례대로) |
| `mkdir [-p] <경로...>` (별칭 `md`) | 디렉터리 생성. `-p` 없으면 상위가 있어야 함 |
| `mv [-n] [-f] [--no-backup] <원본...> <대상>` (별칭 `move`) | 이동·이름 변경. 대상이 디렉터리면 그 안으로. 덮어쓰는 대상 파일은 `<대상>.bak` 으로 보관 |
| `cp [-r/-R] [-n] [-f] [--no-backup] <원본...> <대상>` (별칭 `copy`) | 복사. FTP 에 복사 명령이 없어 임시 파일로 받아 다시 올림(크기 검증). 덮어쓰는 대상 파일은 `.bak` 보관 |
| `touch [-c] <경로...>` | 없는 파일을 빈 파일로 생성. 이미 있으면 그대로 둠 |
| `chmod [-R] <모드> <경로...>` | `SITE CHMOD`. 숫자 모드(644, 755)만, 서버가 지원하지 않으면 오류 |
| `tee [-a] [-q] [-f] [--no-backup] <경로...>` | 표준 입력을 원격 파일에 저장하고 stdout 으로도 출력. heredoc 으로 파일 쓰기 대용 |
| `sed -i [--dry-run] [-f] [--no-backup] <스크립트> <경로...>` | 원격 파일 직접 수정. `-i.bak` 형식도 받음(백업 이름은 항상 `<경로>.bak`). 바뀐 내용이 없으면 올리지 않음 |

```sh
ftcli tee wp-content/themes/x/notice.html <<'EOF'
<p>점검 중</p>
EOF
ftcli sed -i --dry-run 's/http:\/\/old\.com/https:\/\/new.com/g' wp-config.php
ftcli sed -i 's|http://old.com|https://new.com|g' wp-config.php
```

- `tee`, `sed -i` 는 덮어쓰기 전 원격 `.bak` 생성, 업로드 후 크기 검증, 실패 시 `.bak` 으로 복원함.
- 작업 집합 파일에 push 안 한 로컬 수정이 있으면 거부(`-f` 로 무시). 덮어쓴 작업 집합 파일은 원격이 바뀐 상태(`status` 의 R)가 되므로 `pull --force` 로 다시 받음.
- `tee` 는 입력이 비어 있는데 기존 파일에 내용이 있으면 거부함(에이전트 셸이 stdin 을 비워 둔 채 실행해 파일을 지우는 것 방지). 의도한 것이면 `-f`.
- `sed -i` 는 바이너리 파일(앞부분에 NUL 바이트)과 UTF-8 이 아닌 파일(EUC-KR 등)을 거부함. CRLF 줄바꿈과 마지막 줄바꿈 유무는 그대로 유지함. 출력 전용 `sed` 는 UTF-8 이 아닌 파일을 바이트 단위로 다뤄 출력 바이트를 보존함(ASCII 패턴만 정확히 맞음).
- `ls -t` 는 서버가 수정 시각을 주지 않으면(MLSD 미지원) 파일이 200개 이하일 때 MDTM 으로 채움. 그래도 모르는 항목은 맨 뒤에 두고 stderr 에 경고함.

- `mv` 는 작업 집합 파일을 옮기면 `state.json` 에서 제거함(새 경로는 다시 `pull`). 옮기거나 덮어쓸 작업 집합 파일에 push 안 한 로컬 수정이 있으면 거부(`-f` 로 무시). `cp` 도 덮어쓸 대상에 같은 검사를 함.
- `touch` 는 기존 파일의 수정 시각을 바꾸지 않음. 바꾸면 작업 집합 `status` 가 원격 변경(R)으로 나와 `push` 가 거부되기 때문임.
- `rm`, `mv`, `cp`, `touch`, `tee`, `sed -i` 는 `.ftcli/index.json` 이 있으면 결과에 맞게 고쳐 둠. `find` / `grep` 을 바로 이어 써도 됨.

- `grep -C n` 은 전역 옵션 `-C`(작업 디렉터리)와 겹치지 않게 내부에서 `--context n` 으로 바꿔 처리함. 작업 디렉터리 `-C` 는 하위 명령 앞에 둠 (`ftcli -C site grep -C 2 foo`).
- `find -type d` 는 인덱스의 파일 경로에서 유추하므로 빈 디렉터리는 나오지 않음.
- 지원하지 않는 것: `find` 의 `-not` `!` `-o` `-exec` `-mtime` `-size`, `sed` 의 `a` `i` `c` `y` `w` 명령과 `{}` 블록, `chmod` 기호 모드(`+x`), 표준 입력을 읽는 `grep` / `sed`. 지원하지 않는 옵션은 무시하지 않고 오류로 끝남.
- `head` / `tail` / `wc` / `sed` / `cat -n` 은 파일 전체를 받아 처리함. 5MB 넘는 로그를 `tail` 하려면 `--force-large` 가 필요하고 전체를 받음.

## 로드맵

- SFTP 지원 (`Transport` 인터페이스 뒤에 구현 추가)
- 텍스트 줄 단위 diff
- 원격 목록 조회 병렬화 / 충돌 시 3-way merge
- 오프라인 명령(`prune`, `release --offline`)이 FTP 접속을 요구하지 않도록 분리

## Acknowledgements

- Design inspired by [Kelvris/ft](https://github.com/Kelvris/ft) (MIT): 명령어 구성, 푸시 전 버전 스냅샷 개념, `.ftignore`.
- Built on [basic-ftp](https://github.com/patrickjuchli/basic-ftp) (MIT).

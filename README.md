# ftcli

FTP 목록 / 로컬 diff / 업로드 / 다운로드 / 백업 CLI + 작업 집합(원격 SSOT) 모드. Node + TypeScript, 전송은 [basic-ftp](https://github.com/patrickjuchli/basic-ftp).

## 설치 / 실행

```sh
npm install
npm run build
node dist/index.js --help   # 또는 npm run dev -- <명령>
```

## 설정

`ftcli init` → `.ftcli/config.json` 생성 후 수정.

```json
{ "protocol": "ftp", "host": "example.com", "port": 21, "user": "user", "secure": false, "remoteRoot": "/" }
```

비밀번호 우선순위: `--password` → `FTPCLI_PASSWORD` 환경 변수 → `config.password`.

무시 규칙: `.ftignore` 또는 `.ftpignore` (`.gitignore` 문법). `.ftcli`, `.git` 은 항상 제외.

## 인증 실패 잠금

`530`(인증 실패)이 한 번 나면 `.ftcli/auth-lock.json` 에 계정·비밀번호 지문만 기록하고, 같은 자격으로는 이후 접속하지 않고 즉시 실패함. 에이전트가 틀린 비밀번호로 명령을 반복 호출해 서버가 IP 를 차단하는 것을 막기 위함. 비밀번호를 바꾸면 자동 해제, 같은 비밀번호로 확인하려면 `--retry-auth`(1회). 성공적으로 접속하면 기록이 지워짐.

### 로그인 횟수 상한

한 명령이 서버에 로그인하는 횟수를 최대 10회로 제한함(`config.json` 의 `maxLogins` 로 조정). 병렬 연결 4개 + 재연결 6회 분량이며, 초과하면 서버 IP 차단을 막기 위해 즉시 중단함. 로그인 시도 사이에는 250ms 간격을 둠.

## 명령

| 명령 | 설명 |
|---|---|
| `ls [dir] [-r]` | 원격 목록 |
| `diff [files...] [--verify]` | 로컬 vs 원격 (`+` 로컬만 / `-` 원격만 / `M` 다름). 기본은 크기 비교, `--verify` 는 해시 비교 |
| `upload [files...] [-n] [--no-backup]` | `+`/`M` 업로드. 덮어쓰기 전 원격에 `<file>.bak` 생성 |
| `download [files...] [-n] [--no-backup]` | `-`/`M` 다운로드. 덮어쓰는 로컬 파일은 `.ftcli/backups/<시각>/` 로 보관 |
| `backup [paths...]` | 원격 파일을 `.ftcli/backups/<시각>/` 로 내려받음 |

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
| `find <패턴>` / `index` | 원격 경로 검색용 캐시(`.ftcli/index.json`) 구축·조회. glob(`**`,`*`,`?`) / 부분 문자열 / `--regex` |
| `grep <패턴> [경로...]` | 원격 내용 검색. 디스크 저장 없이 메모리로 받아 검색. `-F -i --glob --max-size -l -m` |
| `cat <경로...>` | 다운로드 없이 stdout 출력 (5MB 초과는 `--force-large`) |
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

## 로드맵

- SFTP 지원 (`Transport` 인터페이스 뒤에 구현 추가)
- 텍스트 줄 단위 diff
- 원격 목록 조회 병렬화 / 충돌 시 3-way merge
- 오프라인 명령(`prune`, `release --offline`)이 FTP 접속을 요구하지 않도록 분리

## Acknowledgements

- Design inspired by [Kelvris/ft](https://github.com/Kelvris/ft) (MIT): 명령어 구성, 푸시 전 버전 스냅샷 개념, `.ftignore`.
- Built on [basic-ftp](https://github.com/patrickjuchli/basic-ftp) (MIT).

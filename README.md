# ftcli

FTP 목록 / 로컬 diff / 업로드 / 다운로드 / 백업 CLI. Node + TypeScript, 전송은 [basic-ftp](https://github.com/patrickjuchli/basic-ftp).

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

## 로드맵

- SFTP 지원 (`Transport` 인터페이스 뒤에 구현 추가)
- 텍스트 줄 단위 diff
- 원격 목록 조회 병렬화 / 3-way merge

## Acknowledgements

- Design inspired by [Kelvris/ft](https://github.com/Kelvris/ft) (MIT): 명령어 구성, 푸시 전 버전 스냅샷 개념, `.ftignore`.
- Built on [basic-ftp](https://github.com/patrickjuchli/basic-ftp) (MIT).

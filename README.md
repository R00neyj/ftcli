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

## 로드맵

- SFTP 지원 (`Transport` 인터페이스 뒤에 구현 추가)
- 텍스트 줄 단위 diff
- 3-way merge / 병렬 전송

## Acknowledgements

- Design inspired by [Kelvris/ft](https://github.com/Kelvris/ft) (MIT): 명령어 구성, 푸시 전 버전 스냅샷 개념, `.ftignore`.
- Built on [basic-ftp](https://github.com/patrickjuchli/basic-ftp) (MIT).

# shizue

플롯과 캐릭터를 만들고 지속적인 대화를 이어가는 캐릭터챗 앱이다. RisuAI처럼
한 사람이 자기 컴퓨터에서 쓴다. 카드 가져오기, 대화 분기·재생성·편집, 기억,
페르소나와 노트, 휴대폰 연결을 제공한다. UI는 한국어·영어·일본어를 지원한다.

## 실행과 검증

설치, 개발 서버와 테스트 명령은 리포지터리 루트
[README.md](../../README.md)를 따른다. 설정 예시는 `.env.example`에 있다.
앱은 한 프로세스다: `make dev`가 API(`/api/*`)와 웹(`next dev`)을 포트 13000 하나로 띄우고,
이 디렉터리의 `.env`를 읽는다. 쓰는 사람은 `npx shizue-plot`으로 설치판을 띄운다.
데이터는 앱 폴더 하나에 있다 — PGlite 데이터베이스(`db/`)와 파일(`files/`) —
개발에서는 `data/app`이고 `SHIZUE_DATA_DIR`가 다른 폴더를 가리킨다. 앱이 시작할 때마다 마이그레이션한다.
기억 모델(KURE-v1)의 가중치는 앱이 처음 시작할 때 Hugging Face에서 배경으로 받는다 — 설치판은 앱 폴더의
`models/`에, `make dev`는 체크아웃의 `data/embedder`에 둔다.

루트에서 `pnpm build`, `pnpm typecheck`, `pnpm test`, `pnpm test:e2e`를 실행한다.
API 테스트는 제 메모리 PGlite에서, 브라우저 테스트는 실행마다 새로 만드는 임시 앱 폴더에서
돌아서 따로 준비할 데이터베이스가 없다.

## 구조

- `apps/api`: Hono API와 앱의 한 프로세스, 로컬 소유자 요청 게이트와 ChatGPT 연결, 생성·기억 처리, 앱 폴더의 파일 저장.
- `apps/web`: Next.js 앱과 next-intl 로케일, 캐릭터·플롯 편집과 챗 화면.
- `apps/cli`: `npx shizue-plot` 패키지 — 명령과, 앱을 묶어 넣는 빌드.
- `apps/e2e`: Playwright 브라우저 테스트.
- `packages/core`: 캐릭터 카드, 프롬프트, 발화와 표시 규약.
- `packages/db`: PGlite(WebAssembly로 도는 PostgreSQL) + pgvector 스키마와 마이그레이션.
- `packages/llm`: RisuAI의 요청 형식들과 제공자 어댑터, ChatGPT 연결, 개발용 echo 모델.

제품 내부 동작은 [ARCHITECTURE.md](docs/ARCHITECTURE.md), 쉬운 말의 안내는
[OVERVIEW.md](docs/OVERVIEW.md)를 참조한다.
챗 내보내기 형식은 루트 [PLATFORM.md](../../docs/PLATFORM.md)가 소유한다.

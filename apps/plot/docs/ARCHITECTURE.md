# shizue — 아키텍처

AI 롤플레이 플롯 서비스. 현재 구현된 시스템을 주제별로 기술한다.
이 문서가 plot 리포의 단일 기준(SSOT)이다. 여기 없는 결정은 구현자가 임의로 내리지 말고 리드에게 보고한다.

관련 문서:
- 챗 내보내기 형식은 리포지터리 루트의 `docs/PLATFORM.md`가 SSOT다.
- 커스텀 UI의 조사·설계 근거와 잔존 리스크 레지스터는 `docs/CUSTOM-UI-DESIGN.md`.
- 크리에이터가 각 필드에 무엇을 쓰면 되는지(유저 공개 vs AI 전용, 도입부·발화 규약·스타일·예시 대화·로어북 작성법)는 `docs/CREATOR-GUIDE.md`. 제품 문구가 아니라 창작 가이드이며, 구현의 기준은 이 문서다.
- `docs/GAP-ANALYSIS.md` / `docs/GLOBAL-RESEARCH.md` / `docs/FEATURE-BACKLOG.md`는 2026-08-05~06 시점의 시장 리서치 스냅숏이다. 현재 상태의 기준은 이 문서다.

## 1. 시스템 개요

- **일급 단위는 플롯 하나다.** 유저는 플롯을 만들고, 그 안에 등장인물(최대 10명)을 두고, 도입부(최대 10개)를 쓰고, 발행하고, 탐색되고, 좋아요·댓글을 받고, 대화한다. 캐릭터는 플롯의 하위 구조물이며 **독자적인 발행·탐색 표면이 없다**. 외부 캐릭터 카드(V1/V2/V3 JSON, PNG tEXt, .charx, JPEG 뒤에 붙은 charx) 임포트는 카드를 감싸는 플롯을 하나 만들고 그 카드를 첫 등장인물로 넣는다. 임포트한 등장인물은 어디서 왔는지 기록되고, 그런 멤버가 있는 플롯은 소유자가 권리를 확인해야 발행된다(§10 임포트 출처와 발행 권리).
- **챗은 플롯에 속한다.** 한 대화 안에서 그 플롯의 등장인물 전원과 내레이터가 함께 말한다. 누가 말하는지는 컬럼이 아니라 **콘텐츠 규약**이다 — 어시스턴트 응답의 `이름: ` 접두 줄은 그 등장인물의 발화, 접두사 없는 줄은 내레이터의 상황묘사이며, 줄 안의 `*별표*`가 그 화자의 상황묘사다(§6 발화 프로토콜).
- 대화는 **append-only 메시지 트리**다. 재생성과 유저 메시지 수정은 형제 노드를 **만들고** head를 옮기지만, 스와이프는 이미 있는 형제로 **head만 옮긴다**(`POST /api/chats/:id/head`는 아무것도 쓰지 않는다). 어느 쪽도 기존 메시지를 지우지 않으므로 모든 가지가 리로드 후에도 남는다. 플롯의 도입부 전부가 parent_id null 형제 루트라, 어느 도입부로 시작할지 고르는 것도 같은 스와이프다.
- 프롬프트는 **서버에서만** 조립된다. 플롯의 세계관 설정과 각 등장인물 카드(설명·성격·로어북·시스템 프롬프트)는 소유자 외에게 API로 나가지 않는다.
- 컨텍스트를 넘긴 히스토리는 롤링 요약 + (임베딩 설정 시) 벡터 검색 사실로 대체된다.
- 플롯은 발행하면 허브(`/` 피드)에 노출된다. 콘텐츠 언어별 하드 파티션.
- 플롯은 표시 스크립트와 샌드박스 JSX 컴포넌트를 실을 수 있고, 컴포넌트는 플롯이 선언한 capability 한도 안에서 챗에 턴을 보낼 수 있다(게임 레이어).

## 2. 스택

- pnpm 워크스페이스 모노레포, TypeScript strict, ESM only. Node ≥22(개발 25), pnpm 10.28.
- `apps/web`: Next.js 15 (App Router) + Tailwind 4 — 프론트엔드 전용, 포트 13000.
- `apps/api`: Hono + @hono/node-server — 모든 비즈니스 로직·인증·SSE, 포트 8787.
- DB: PostgreSQL 17 (`pgvector/pgvector:pg17`, docker-compose, 15433). **pgvector는 실사용 중** — `memories.embedding vector(1536)`.
- ORM: Drizzle + drizzle-kit 마이그레이션.
- 인증: Sign in with ChatGPT가 유일한 로그인이다(§4.1). 세션은 서버 측 `session` 행과 HttpOnly 쿠키이고(`hostedAuth.ts`), 별도 회원가입·비밀번호는 없다. better-auth는 `NODE_ENV=test`의 다중 사용자 테스트 픽스처에만 쓰인다.
- 테스트: vitest (루트 `pnpm test`가 전체 실행), E2E는 Playwright(`apps/e2e`).
- 웹→API: Next `rewrites` 프록시 (same-origin, CORS 불필요). 프록시에는 자기 바디 상한이 있다(§10 바디 상한).

## 3. 레포 구조

```
plot/
  pnpm-workspace.yaml       # packages/* , apps/*
  package.json              # dev, build, test, typecheck, db:*
  docker-compose.yml        # postgres 15433 (db/user/pw = plot), docker/init-db.sql
  vitest.config.ts          # 루트에서 전 패키지 테스트
  .env.example
  docs/
  packages/
    core/                   # @shizue/core — 카드 파싱/정규화, 매크로·변수, 로어북, 프롬프트 조립,
                            #   발화 프로토콜, 표시 스크립트, 컴포넌트 서브셋 검사, 토큰 카운트
    db/                     # @shizue/db — Drizzle 스키마·클라이언트·마이그레이션
    llm/                    # @shizue/llm — 프로바이더 어댑터, 모델 레지스트리, 임베더
  apps/
    api/                    # @shizue/api — Hono 서버
    web/                    # @shizue/web — Next.js
    e2e/                    # @shizue/e2e — Playwright 스모크·회귀 스펙
```

`@shizue/core`는 서브패스 익스포트를 갖는다: `./variables`, `./cbs`, `./display-script`, `./component`, `./narration`, `./speech`, `./status-block`, `./choices`, `./scene`, `./world-info` — 웹이 토크나이저·카드 파서를 번들에 끌어오지 않고 같은 로직을 쓰기 위한 경계다.

**워크스페이스 밖 의존**: `apps/api`와 `apps/web`은 `@shizue/contracts`를 `workspace:*`로 참조한다. 이 트리가 아니라 리포지터리 루트의 `packages/contracts`에 있는 패키지다 — 예전에는 형제 체크아웃을 전제한 `link:` 파일 링크였고, 지금은 같은 워크스페이스의 패키지 링크다. 경계를 건너는 페이로드 스키마는 반드시 여기서 import한다(복제 금지, PLATFORM.md §1).

## 4. 환경변수

`.env.example`가 기준이며, API는 리포 루트 `.env`를 dotenv로 읽는다(`apps/api/src/env.ts`).

```
DATABASE_URL=postgres://plot:plot@localhost:15433/plot     # 필수, 없으면 기동 실패
TEST_DATABASE_URL=postgres://.../plot_test                  # pnpm test 전용 스크래치 DB (§12 테스트)
                                                            # 마이그레이션 대상은 DATABASE_URL 이다:
                                                            # DATABASE_URL=<스크래치> pnpm db:migrate
                                                            # (drizzle.config.ts 가 루트 .env 를 읽고,
                                                            #  미설정이면 폴백 없이 실패한다)
BETTER_AUTH_URL=http://localhost:13000                     # 웹 오리진(경로 없음). 쓰기의 Origin과 로그인 복귀 주소
BETTER_AUTH_SECRET                                          # ChatGPT 토큰 봉인 키·호스트 ID의 원천. production 필수
API_PORT=8787
API_HOST=127.0.0.1               # API를 별도 서버에 둘 때 0.0.0.0 (웹의 API_ORIGIN을 그리로)
STORAGE_DRIVER=local             # local(기본) | s3 — 부팅 때 한 번 결정 (§9.2)
UPLOAD_DIR=./data/uploads        # 로컬 드라이버 루트, 이미지 네임스페이스 전부 (리포 루트 기준 resolve)
S3_BUCKET / S3_REGION / S3_ENDPOINT                        # STORAGE_DRIVER=s3 일 때만
S3_ACCESS_KEY_ID / S3_SECRET_ACCESS_KEY                    # 둘 다 비면 SDK 자격증명 체인
S3_FORCE_PATH_STYLE=true         # 로컬 RustFS 필수, AWS 는 false
CHATGPT_CALLBACK_PORT=47801      # OpenAI 루프백 콜백 포트. 도우미 확장 규칙과 오리진마다 짝 (§4.1)
```

`.env.example`에 없지만 코드가 읽는 것:

| 변수 | 소비자 | 의미 |
|---|---|---|
| `API_ORIGIN` | `apps/web/next.config.ts` | `/api/*` rewrite 타깃, 기본 `http://localhost:8787` |
| `NODE_ENV` | `apps/api/src/index.ts` | `test`에서만 better-auth 픽스처와 Echo 모델을 허용. 정상 실행은 ChatGPT 로그인만 사용 |
| `CHATGPT_FAKE_OPENAI` | `apps/api/src/index.ts` | `NODE_ENV=test`에서 `1`이면 OpenAI 로그인 엔드포인트를 프로세스 안에서 흉내 낸다(`testOpenAI.ts`, 브라우저 스위트 전용) |
| `NEXT_PUBLIC_CHATGPT_EXTENSION_ID` / `_URL` | `apps/web/src/lib/chatgptExtension.ts` | 도우미 확장 ID(기본은 고정 키의 ID)와 선택적 설치 링크 |


### 4.1 호스팅 경계와 로그인 (`readConfig`, `originGuard`, `chatgptAccounts`)

웹과 API는 여러 사용자가 접속하는 서비스로 돈다. API는 `API_HOST`에 바인딩하고, `originGuard`가
변경 요청의 Origin을 `BETTER_AUTH_URL`과 대조하며(CSRF), Origin이 실린 요청은 그 오리진만,
Next rewrite가 넘긴 요청은 `x-forwarded-host`가 웹 호스트일 때만 받는다(DNS 리바인딩).

로그인은 OpenAI의 오픈소스 Sign in with ChatGPT 흐름이다. 그 흐름은 `http://127.0.0.1:<port>/auth/callback`
으로만 돌아오고 이 주소는 사용자 기기를 가리키므로, 저장소의 크롬 확장(`apps/extension`)이 정적
declarativeNetRequest 규칙으로 그 이동을 연결 전에 `<웹 오리진>/api/chatgpt/callback`으로 바꾼다(쿼리 유지).
포트는 오리진마다 하나이고 API의 `CHATGPT_CALLBACK_PORT`와 확장 규칙이 같아야 한다.

1. `POST /api/chatgpt/sign-in {next, locale}` — PKCE·state·nonce를 만들어 `verification` 행에 10분 보관하고,
   시도를 그 브라우저에 묶는 HttpOnly 쿠키를 심은 뒤 `authorizationUrl`을 준다. 브라우저는 같은 탭으로 이동한다.
2. `GET /api/chatgpt/callback` — 시도 행을 **지우면서** 읽고(1회용), 쿠키 다이제스트가 맞을 때만 코드를 교환한다
   (로그인 CSRF). ID 토큰의 `sub`가 계정의 키다(`account`의 `chatgpt/<sub>`). 성공하면 세션 쿠키를 주고
   `/{locale}{next}`로, 실패하면 `/{locale}/login?error=<code>&next=…`로 보낸다. 리디렉트된 콜백에는 Origin도
   Referer도 없으므로 인증 근거는 state와 쿠키뿐이다.
3. 토큰은 `account` 행에 AES-256-GCM으로 봉인한다(키는 `BETTER_AUTH_SECRET`에서 HKDF). 비밀을 바꾸면 봉인이
   열리지 않아 전원이 다시 로그인한다. 갱신은 그 행의 `for update` 락 아래에서 한 번만 하고, 다시 읽어 이미
   회전됐으면 그 값을 쓴다. `invalid_grant` 등 권한이 사라진 응답이면 토큰을 지운다.
4. OpenAI가 계정마다 발급한 `client_id`는 `account.client_id`에 남고, 브라우저의 HttpOnly 쿠키가 그것을 기억해
   다음 로그인이 같은 등록을 다시 쓴다(등록이 쌓이지 않게). 서버는 OpenAI에게 호스트 하나이며
   `ext_agent_host_id`는 비밀에서 파생한 `urn:uuid`다.
5. 로그아웃(`POST /api/chatgpt/sign-out`, `/api/auth/sign-out`)은 refresh token 해제를 시도하고 토큰을 지우되
   등록은 남기며, 그 사용자의 세션을 모두 끝낸다.

예전 로컬 설치의 내부 소유자(`account`의 `local-workspace/default`)는 첫 ChatGPT 로그인이 한 번 넘겨받는다 —
작품과 대화가 그대로 이어진다. 그 뒤 바인딩 행은 사라진다.

OpenAI의 오픈소스 흐름은 오픈소스·로컬 호스팅 앱이 대상이다. 원격 호스팅 서비스가 사용자 토큰을 서버에
보관하는 것은 별도 신청이 필요하므로, 승인 전에는 운영자 본인 계정으로만 테스트한다.


## 5. 도메인 모델

**스키마의 권위는 `packages/db/src/schema/app.ts`다.** 컬럼 목록을 여기 복제하지 않는다 — 아래는 테이블이 무엇을 위해 있고 어떤 규약을 지는지만 기술한다. better-auth 테이블(`user`, `session`, `account`, `verification`)은 `schema/auth.ts`에 better-auth CLI 스키마 그대로 있다.

### 플롯·등장인물

- `plots` — **이 스키마의 일급 행**. 소유자, 제목, `intro`(독자용 소개), `description`(모델용 세계관 설정), `cover_path`(스토리지 키, §9.2), `lorebook jsonb`, `intros jsonb`(도입부 string[], 최대 10개·개당 4,000자를 API가 집행), `narrator jsonb`, `style jsonb`(크리에이터가 정한 연출 옵션 묶음 — 시제·응답 길이·표현 방식·전개 속도·난이도·분위기·스토리텔링 문체·상태창·선택지, §6), `profiles jsonb`(작품이 권하는 독자 프로필, 아래), `custom_ui jsonb`(표시 스크립트·기본 변수·컴포넌트 코드·capability를 한 컬럼에). 노출 축이 셋이다: `visibility`(private/public), `language`(ko/en/ja 콘텐츠 언어), `safety_level`(all/adult — 연령 인증이 없는 이 빌드에서 API는 all만 받고, adult는 그 전에 저장된 행에만 남는다). 발행 시 `published_at`과 `tags`(최대 10개·개당 20자)가 갱신된다. `rights_confirmed_at`은 소유자가 임포트한 멤버에 대한 권리를 **마지막으로** 확인한 시각이다 — 그런 멤버가 있는 발행과 공개 중인 플롯으로의 임포트가 찍고, 비공개 전환은 지우지 않는다(§10). `like_count`는 `plot_likes` 행과 같은 트랜잭션에서 움직이는 비정규화 카운터다. `chat_count`는 그렇지 않다 — 챗 생성과 카운터 증가가 **별개 문장**이고(트랜잭션 없음), 챗을 지워도 **감소하지 않는다**. 지금까지 남이 이 플롯으로 대화를 몇 번 시작했는지를 누적하는 인기 지표이지 현재 챗 수가 아니며, 증가 문장이 실패하면 조용히 낮게 어긋난 채로 남는다. `comments_enabled`로 크리에이터가 댓글창을 닫을 수 있다.
- `plots.style`은 **열거값만** 담는다 — 자유 텍스트가 없다. 그래서 공개 뷰에 그대로 실려 나가 배지가 되고(§10·§11), 모델이 읽는 지시문은 그 열거값을 코어가 컴파일한 우리 문장이지 크리에이터가 쓴 글이 아니다(§6). 알아볼 옵션이 하나도 없으면 API가 `null`로 저장하고, 스튜디오 에디터는 기본값과 같아진 옵션을 아예 빼고 넘긴다(`lib/plotStyle.ts`) — 스타일을 건드린 적 없는 플롯과 골랐다가 되돌린 플롯이 같은 빈 컬럼이 되는 것이 그래서다.
- `plots.profiles`는 **독자를 향한 글이다** — `{id, name(30자), description(1000자)}` 최대 5개, 아바타는 없다(v1). 프롬프트에 닿지 않는 것이 핵심 규약이다: 독자가 하나를 고르면 서버가 그것을 **독자 소유의 `personas` 행으로 복사**하고, 챗이 가리키는 것도 프롬프트에 실리는 것도 그 복사본이다(§10). 그래서 고른 뒤에 독자가 자기 페르소나처럼 고쳐 쓸 수 있다. `coercePlotProfiles`는 스타일과 같은 규약을 진다 — 이름이 없는 행은 거절이 아니라 삭제, id는 없으면 발급, 상한 초과는 잘라내고, 남는 것이 없으면 컬럼은 `null`이다.
- `intro`와 `cover_path`는 **프롬프트에 닿지 않는다** — `description`이 모델을 향한 글이고 이 둘은 독자를 향한 것이라 컬럼이 따로 있다. 같은 이유로 등장인물 카드의 `intro`도 프롬프트에 들어가지 않는다(§6).
- 탐색 인덱스는 정렬별로 하나씩 `plots`에 있고, `(visibility, language)` 하드 파티션이 앞에 오고 마지막이 `id`다 — 커서의 타이브레이크와 같은 순서라 다음 페이지가 동점 그룹 안으로 seek한다. `tags`는 GIN.
- `characters` — 플롯의 하위 구조물. `plot_id`(NOT NULL, 플롯 삭제 시 `cascade`), `name`, 정규화 카드(`card jsonb`, §6), 아바타 경로, `order_index`. **자기 소유자도 공개 축도 갖지 않는다** — 소유·가시성·세이프티·언어·태그·좋아요·댓글은 전부 플롯의 것이고, 권한 검사는 언제나 플롯을 거친다. `name`은 카드에서 읽지 않고 행이 직접 갖는데, 이것이 발화 프로토콜이 매칭하는 화자 접두사이기 때문이다(§6). 플롯당 10명 상한은 API가 집행하고, 인덱스는 `(plot_id, order_index)` 하나 — 생성할 때마다 로스터 전체를 순서대로 읽는 그 쿼리다. `order_index`는 unique가 아니다(재정렬이 전체를 다시 쓰므로 잠깐 겹쳐도 순서만 동률이 된다).
  - `imported_from jsonb`(null 가능)은 카드 파일로 들어온 멤버의 출처 기록이다 — `ImportProvenance` `{fileName, sha256, sourceUrl?, importedAt}`. 스튜디오가 만든 멤버는 null이다. 카드 필드가 아니라 컬럼인 이유는 이것이 인물이 무엇인지가 아니라 **행이 어떻게 생겼는지**의 기록이라서다 — 익스포트에 실리지 않는다. 증명이 아니라 신고 대응용 기록이다: `sha256`은 서버가 받은 바이트를 직접 해시한 것이지만 `sourceUrl`은 가져온 사람의 말이다. 소유자 응답에만 실리고(§10), 공개 표면에는 실을 필드가 없다. 발행 게이트가 "임포트한 멤버가 있는가"를 이 컬럼의 null 여부로 판정하므로, 임포트한 멤버를 지우면 그 질문도 함께 사라진다.
- `plot_assets` — 메시지 안에서 `{{img::slug}}`로 참조되는 이미지. `(plot_id, slug)` unique, **플롯당 100개**(API가 집행). 업로더가 미리 잰 `width`/`height`/`thumbhash`를 같이 싣는다(charx 임포트로 들어온 것은 셋 다 null이라 자리 예약 없이 그려진다). `name`(null 가능)은 임포트한 카드가 그 그림에 붙인 **원래 이름**이다 — RisuAI 카드는 렌더 시점에 이 이름으로 참조를 조립하고(`{{img::{{getvar::outfit}}.png}}`), slug는 그것을 대신할 수 없다(한글 이름은 slug로 접으면 아무것도 남지 않는다). 업로드한 그림은 null이다. `unlock jsonb`(null 가능)은 이 그림이 **한 대화에서** 열리기까지 무엇이 필요한지다 — `{kind:'keyword', keywords[1..5]}` · `{kind:'turns', count 1..500}` · `{kind:'relationship', axis, min 1..100}` 셋뿐이고, null이면 언제나 보이는 지금까지의 동작이다. **이것은 접근 제어가 아니라 연출이다**: 바이트는 여전히 플롯을 읽을 수 있는 누구에게나 서빙되고(§10), 잠기는 것은 한 대화에서의 공개다. `coerceAssetUnlock`은 알아볼 수 없는 조건을 `null`로 만든다 — 아무것도 만족시킬 수 없는 조건은 영영 잠긴 그림이기 때문이다.
- `chat_asset_unlocks` — `(chat_id, asset_id)` PK, 양쪽 cascade. 한 대화가 이미 연 그림. 삽입은 언제나 `on conflict do nothing`이고 **실제로 들어간 행만 반환**하므로, 같은 조건을 두 번 평가해도 행은 하나고 처음 넣은 쪽만 그것을 보고한다 — 턴 경로와 관계 경로가 서로를 모른 채 자유롭게 물어볼 수 있는 이유다(§7.5).
- `plot_likes` — `(user_id, plot_id)` PK. 주간 인기 정렬이 `(plot_id, created_at)` 인덱스로 이 행들을 되읽는다(§10).
- `comments` — 플롯 공개 페이지의 댓글, 1단계 대댓글까지(`plot_id`). 삭제는 소프트지만 같은 쓰기에서 `content`를 비운다(행은 대댓글의 앵커로만 남는다).

### 챗 트리

- `chats` — 소유자·**플롯**·페르소나·모델·프리셋·유저노트, 그리고 계층별 설정(`memory*`, `relationship*`, 내레이터 오버라이드, `allow_component_turns`, `status_window_enabled`/`choices_enabled`). `head_message_id`는 현재 브랜치의 리프이며, messages와의 순환 FK를 피하려고 제약 없는 uuid다.
  - `status_window_enabled`·`choices_enabled`는 **독자 몫의 스위치**이고 둘 다 기본 true다. 플롯이 그 기능을 켠 대화에서만 의미가 있다 — 조립기에는 플롯 설정과의 **교집합**만 간다(`apps/api/src/plots.ts`의 `chatStyle`). 플롯이 상태창을 끈 작품은 챗 컬럼이 true여도 상태창 지시문을 받지 않고, 독자가 선택지를 끄면 플롯이 어떻게 정했든 선택지가 붙지 않는다. 반대로 **응답 길이는 크리에이터 전용**이라 독자 토글이 없다.
  - `absent_character_ids`(string[], null 가능)는 독자가 **장면에서 뺀** 등장인물이다. 그 멤버의 카드 블록·예시 대화·카드 로어북이 프롬프트에서 빠지고 한 줄 안내가 대신 남는다(§6). 빈 목록은 null로 저장하고(로스터 전원 등장), 멤버가 삭제되어 남은 id는 아무와도 맞지 않아 그냥 무시된다.
- `messages` — append-only 트리. `parent_id`가 null이면 루트(인사). `source`는 유저 턴을 누가 썼는지(`user` | `component`), `directions`는 그 턴에 게임 컴포넌트가 붙인 판정이다. `lore_triggers`(string[], null 가능)는 그 assistant 턴의 프롬프트에서 **새로** 발동한 로어 엔트리의 키(`loreEntryKey`)다 — 지속·재사용 대기 같은 시한 효과가 브랜치에 남은 이 기록으로 계산된다(§6 로어북). 새 assistant 행을 넣는 경로(전송·재생성·자동진행·나레이션)만 쓰고, 이어쓰기는 같은 턴이라 기록을 건드리지 않는다. 클라이언트 JSON에는 실리지 않는다.
- 트리 규약. **행을 새로 넣는 연산은 넷뿐이다** — 챗 생성(인사 루트들), 유저 턴 전송(유저 메시지 + 그에 대한 assistant), 재생성/자동진행(assistant), 유저 메시지 수정(유저 형제). 스와이프·assistant 메시지 수정·이어쓰기는 행을 만들지 않는다.
  - 현재 경로 = `head_message_id`에서 parent 체인을 루트까지 역추적.
  - 재생성 = 마지막 assistant와 같은 parent로 새 sibling → head 이동. head가 유저 메시지면 그 아래 assistant 자식을 만든다(실패 후 재시도·edit-fork 후 응답 경로).
  - 스와이프 = `POST /:id/head`가 head를 sibling 서브트리의 **최신 자식 후손 리프**로 옮긴다. 메시지를 만들지 않는다 — 스와이프가 형제를 만드는 게 아니라, 재생성이 만들어 둔 형제 사이를 오갈 뿐이다. `deepestLeaf`는 각 층에서 가장 최근 자식을 따라 내려가지 서브트리에서 가장 깊은 잎을 찾지 않는다 — 그 sibling 아래에 더 오래되고 더 깊은 가지가 있으면 거기로 가지 않는다.
  - 유저 메시지 수정 = 같은 parent로 새 sibling(새 브랜치) → head 이동.
  - assistant 메시지 수정 = in-place. 이어쓰기(continue)도 in-place append라 트리가 변하지 않는다.
  - 첫 인사는 **플롯의 `intros` 전부**를 parent_id null 형제 루트로 한 번에 저장한다(최대 10개). head는 `POST /api/chats`가 받은 `introIndex`(기본 0)가 가리키는 루트다. 매크로 확장 후 빈 도입부는 저장하지 않고, 선택한 도입부가 비면 루트 없이 빈 챗으로 시작한다. 벌크 insert가 같은 `created_at`을 갖지 않도록 행마다 1ms씩 어긋난 값을 명시한다. 도입부 텍스트의 `{{char}}`는 **플롯 이름**으로 확장된다(§6 매크로). 시계 매크로는 챗을 여는 순간 독자의 시계로 풀리고, `{{pick}}`에는 seed가 없다 — 챗 id는 그 뒤의 insert가 발급한다.

### 기억

- `chats.memory` — 롤링 요약 + anchor 메시지 id. `chats.memory_revision`은 무효화 카운터(§7.2).
- `chats.memory_settings` — 챗별 오버라이드(`contextBudget` 8000/16000/32000, `summaryThreshold` 0.4/0.6/0.8, `retrievalCount` 0~10). null이면 파이프라인 기본값.
- `memories` — 추출된 장기 사실(`plot_id`로 플롯에 매달리지만 검색은 챗 단위, §7.3). `embedding`은 임베더가 없으면 null이고, 그 행은 영영 검색되지 않는다.
- `user_notes` / `chat_note_links` — 계정 단위 재사용 노트(100개·2000자)와 챗 첨부(10개). 캡은 API가 집행한다.

### 커뮤니티

- `follows` — `(follower_id, creator_id)` PK, 양쪽 user cascade. 자기 자신을 팔로우하는 것은 조용히 버리지 않고 **400**이다: 자기가 들어간 팔로워 수는 거짓말이고, 그런 요청은 버튼을 잘못 그린 클라이언트다.
- `notifications` — 수신자, `plot_published` kind, 발행자와 플롯, 생성·읽음 시각. 플롯 삭제 시 cascade이며 `(user_id, plot_id, kind)` unique가 팬아웃 재시도의 중복 알림을 막는다. 행 단위 읽음 없이 `POST /api/notifications/read`로 모두 읽는다.
- 알림 행은 **발행 트랜잭션이 쓰지 않는다**. 발행은 잡 한 행을 큐에 넣고(§10 발행, `jobs` 아래) 워커가 팔로워를 1,000명씩 걸으며 삽입한다. **팔로워 상한은 없다** — 상한은 인라인 팬아웃이 큐 대신 갖고 있던 것이었고, 발행 트랜잭션이 팔로워 수에 비례해 길어지지 않는 지금은 필요가 없다. 알림 대상은 **발행 시각 기준**이다 — 페이로드에 발행 스탬프가 실려 가고 순회가 `follows.created_at <= 발행시각`으로 자른다. 인라인 팬아웃은 발행 트랜잭션 안에서 돌았으므로 이 성질을 공짜로 가졌지만, 큐는 1분 뒤에 돌 수도 있어서 그 사이에 팔로우한 독자에게 옛 발행을 알리게 된다("팔로우는 과거 구독이 아니다", §10). 워커가 팔로워 목록을 걷는 사이에도 팔로우·언팔로우는 계속 생기므로 순회는 오프셋이 아니라 `(created_at, follower_id)` 키셋이고, 경계값은 배치가 읽어 온 행에서 **텍스트로** 들고 간다 — JS `Date`는 밀리초라 마이크로초가 잘려 나가고(내림이라 내림차순 순회에서 사람이 통째로 누락된다), 경계 행을 서브쿼리로 다시 읽는 방식은 그 팔로워가 배치 사이에 언팔로우하면 비교가 통째로 unknown이 되어 순회가 조용히 끝난다. 재시도가 이미 쓴 배치를 다시 쓰더라도 `notifications`의 `(user_id, plot_id, kind)` unique 제약이 같은 사람에게 두 번 알리는 것을 막는다.
- `feed_cursors` — 카운터 정렬 피드(탐색 `likes`/`chats`) 한 번의 순회가 지금까지 내준 행 id를 순서대로 담는 스냅숏. 커서는 이 배열 안의 오프셋이고, 카운터가 움직여도 순회가 각 행을 정확히 한 번 보게 만드는 장치다(§10 커서). **1페이지는 이 테이블을 건드리지 않는다** — 행은 독자가 2페이지 커서를 실제로 소비할 때 비로소 생긴다. 백그라운드 잡이 없으므로 순회를 열 때 TTL(1시간) 지난 것들을 **한 번에 50개까지만** 수거한다(한 번 열 때 1개를 만들고 50개를 지우니 밀린 것은 줄어들기만 한다).
- `jobs` — 요청이 하지 않고 넘긴 일(`kind`·`payload` jsonb·`run_at`·`attempts`·`status`). 브로커가 아니라 Postgres인 이유는 하나다: **enqueue가 그것을 시킨 쓰기와 같은 트랜잭션에서 커밋된다**(`enqueueJob(tx, …)`). 롤백된 발행은 팬아웃도 남기지 않는다. 클레임은 `status='pending' and run_at <= now()`인 가장 오래된 행을 `for update skip locked`로 한 행씩 집어 `locked_at`을 찍는 단일 UPDATE이고, `locked_at`은 락이 아니라 **리스**다 — 도중에 죽은 워커의 잡은 2분 뒤 다른 워커가 가져간다(`chats.generating_at`과 같은 규약). 클레임은 **남은 시도가 있는 행만** 집는다(`attempts < max_attempts`) — 그래서 마지막 시도 도중에 워커가 죽어 리스만 만료된 행은 클레임 직전의 한 문장이 `failed`로 쓸어 담는다. 안 그러면 아무도 집지 않는 `pending`으로 영원히 남는다. 리스를 쥔 워커가 그 잡에 대해 쓰는 모든 문장(완료·실패·리스 갱신)은 `attempts`를 펜싱 토큰으로 삼는다 — 인수인계는 언제나 `attempts`를 올리므로, 리스가 만료된 채 돌고 있던 워커가 뒤늦게 돌아와 새 주인의 상태를 덮어쓰지 못한다. 핸들러가 도는 동안 1분마다 `locked_at`을 갱신하므로 리스보다 오래 걸리는 핸들러가 죽은 워커로 오인되지 않는다. 핸들러가 던지면 `run_at`을 2^attempts분 뒤로 밀고, `max_attempts`(5)를 쓰면 `failed`에서 멈춘다. 핸들러는 큐 모듈이 import하지 않고 인자로 받는다(테스트가 갈아끼운다). API 인스턴스마다 워커 루프가 하나씩 돌고, 서로를 아는 장치는 `skip locked`뿐이다.

## 6. 카드·프롬프트 파이프라인 (packages/core)

### NormalizedCard

내부 표준. CCv3 기반 서브셋이며 정의는 `packages/core/src/types.ts`에 있다. **카드는 이제 임포트·익스포트의 왕복 컨테이너이자 등장인물 한 명의 정의다** — 작품에 속하는 것(도입부·내레이터·커스텀 UI)은 임포트가 플롯 컬럼으로 들어 올린다(§5, §10). 스펙 필드 외에 우리 확장이 있다:

- `displayScripts?` — 표시 전용 변환(§8.1).
- `defaultVariables?` — 경로 파생 변수의 시드.
- `componentCode?` — Layer 2 JSX 모듈(40,000자 상한).
- `componentCapabilities?` — 컴포넌트가 챗에 요청할 수 있는 것(현재 `'sendTurn'` 하나).
- 위 넷은 카드 필드로 남아 카드와 함께 이식되지만, **런타임이 읽는 것은 `plots.custom_ui`다**. 임포트가 카드에서 들어 올리고 익스포트가 카드로 되돌려 쓴다.
- `intro?` — 유저 노출용 소개(500자 상한). **`prompt.ts`가 읽지 않는 유일한 카드 필드다** — `description`이 모델을 향한 글이고 이쪽은 독자를 향한 글이라, `creatorNotes`(CCv3 의미론이 다르다)에 합치지 않고 자체 필드로 둔다. 플롯 공개 뷰의 등장인물 소개(§10)에 실려 나간다.
- `scenario`는 **더 이상 읽히지 않는다**. 상황은 플롯의 `description`이거나 도입부이지 한 인물의 것이 아니기 때문이며, 왕복을 위해 필드 자체는 그대로 보존된다.

왕복하는 것은 **정규화 필드 + `extensions`**다. `exportCardV3`는 정규화 필드로 V3 카드를 다시 짓고, `extensions`를 그대로 실은 뒤 거기에 우리 확장 블록을 다시 써넣는다 — 스펙에 대응 필드가 없는 것(RisuAI 표시 스크립트·기본 변수, 우리 컴포넌트 코드·capability)이 이 통로로 살아남는다. `raw`(원본 카드 JSON 전체)는 **어떤 코드도 읽지 않는다**: 보관·진단용으로 카드 jsonb 안에 남아 있을 뿐 익스포트에 관여하지 않는다.

`LoreEntry`는 keys/secondaryKeys/selective/constant/insertionOrder/caseSensitive/useRegex/position에 더해 V3 데코레이터(또는 SillyTavern 엔트리 확장·스튜디오의 고급 칸)에서 온 `depth?`·`role?`, 그리고 SillyTavern의 고급 발동 필드 `selectiveLogic?`·`probability?`·`group?`·`groupWeight?`·`scanDepth?`·`sticky?`·`cooldown?`·`delay?`를 갖는다(§6 로어북). 고급 필드는 **없는 것이 기본값**이라 기본값을 채워 넣지 않는다 — API의 `coerceLoreEntry`도 보낸 것만 정수로 반올림·클램프해 남긴다(확률 0–100, 그룹 가중치 1–1000, 스캔 깊이 0–1000, 지속·재사용 대기·지연 0–10000, 모르는 selectiveLogic과 빈 그룹은 버린다).

### 파싱·정규화

- `card/parse.ts`가 입력 종류를 판별한다: PNG 시그니처 → tEXt 청크(`ccv3` 우선, 없으면 `chara`, base64 → JSON), ZIP 시그니처 → charx, JPEG 시그니처(`FF D8 FF`) 뒤에 charx가 붙어 있으면 → 그 charx, 그 외 → JSON.
  - **RisuAI PNG 카드는 다른 그림도 싣는다.** 그림마다 tEXt 청크 `chara-ext-asset_:N`(base64)에 넣고 카드에서는 uri `__asset:N`으로 가리킨다(RisuAI 리더처럼 콜론 없는 `chara-ext-asset_N`도 읽는다). 목록은 RisuAI가 spec에 따라 읽는 자리를 그대로 따른다: V3는 `data.assets`(메인 아이콘은 빼고 — PNG 자체가 아바타다), V2는 `extensions.risuai`의 `emotions`(`[name, uri]`, 언제나 png)와 `additionalAssets`(`[name, uri, ext]`, ext가 없으면 png). 이미지 확장자 규칙·50개·엔트리당 20MiB·64MiB 예산은 charx 상수를 그대로 쓴다. 디코딩 크기는 청크 길이로 미리 알 수 있어 캡을 넘는 에셋은 디코딩 전에 그 자리에서 멈추고(charx 패스처럼 그 뒤는 버린다), 청크는 입력에 대한 뷰로 읽어 고른 것만 디코딩한다. 이름이 비면 `asset_N`.
  - **JPEG 뒤의 charx는 RisuAI의 'charx jpeg' 익스포트다** — 그림을 쓰고 그 뒤에 zip 전체를 스트리밍한다. 로컬 헤더 시그니처 `PK\x03\x04`는 JPEG 데이터에도 우연히 나올 수 있어 앞에서부터 찾지 않고 끝의 EOCD 레코드로 찾는다. RisuAI는 오프셋을 그림만큼 밀지 않으므로 zip 시작 = 중앙 디렉터리의 실제 위치 − 기록된 오프셋이다. 아바타는 앞의 JPEG가 아니라 아카이브가 선언한 아이콘이다(RisuAI 임포트도 그렇다).
- `card/normalize.ts`는 **항상 `@risuai/ccardlib`로 변환한다**(V1/V2 → V3). 직접 매핑 경로는 없다.
  - **SillyTavern이 쓴 카드는 ccardlib 스키마에 그대로는 맞지 않는다.** ST의 PNG `ccv3` 청크는 V2 JSON의 spec만 바꾼 것이라 `group_only_greetings`가 없고, ST가 만든 로어북에는 책 단위 `extensions`가 없다. 그대로 검사하면 거절이 아니라 **V1로 통과한다** — ST는 V1 필드를 최상위에 반복해 쓰므로 `data` 아래 전부(로어북·추가 인사·시스템 프롬프트)를 잃는다. 그래서 spec이 V2/V3인 카드는 검사 전에 이 둘을 사본에 채운다(`raw`는 원본 그대로).
  - 엔트리 매핑은 `card/bookEntry.ts` 한 곳이다(의존성 없음 — `./world-info`가 웹으로 가져간다). 같은 설정이 세 곳에 있을 수 있고 **V3 데코레이터 > ST 엔트리 `extensions` > CCv3 필드** 순으로 이긴다. ST는 내보내는 모든 엔트리에 숫자 `extensions.position`과 설정 전부를 쓰므로 그것으로 ST 엔트리를 알아본다: `position` 0/1 → before/after char, 4 → `depth`(`extensions.depth`, 없으면 4)와 `role`(0 system·1 user·2 assistant), 그 밖(작가 노트 위아래·예시 대화·아웃렛) → before_char. `selectiveLogic` 0 AND_ANY·1 NOT_ALL·2 NOT_ANY·3 AND_ALL, `probability`는 `useProbability`가 꺼지지 않았고(없으면 켜짐) 100 미만일 때만, `group`·`group_weight`·`scan_depth`·`sticky`·`cooldown`·`delay`, 대소문자는 `extensions.case_sensitive`에서. ST가 기본값으로 쓴 값(AND_ANY, 확률 100, 가중치 100, 0인 시한 효과, system 역할)은 **없는 것으로** 읽는다.
  - **ST는 `use_regex`를 읽지 않는다**(그리고 모든 엔트리에 true로 쓴다). 키가 `/패턴/플래그` 꼴일 때만 정규식이다. 우리 것은 엔트리 단위라, ST 엔트리는 그 꼴의 키가 하나라도 있으면 정규식 엔트리가 되어 그 키는 패턴만 남기고(플래그는 버리고 대소문자는 엔트리 설정을 따른다) 나머지 평문 키는 이스케이프된 리터럴이 된다. 없으면 평문 엔트리다. ST가 아닌 엔트리는 `use_regex`를 그대로 믿는다.
  - `card/sillyTavern.ts` — `extensions.depth_prompt`(캐릭터 노트, `{prompt, depth, role}` — role은 낱말 'system'|'user'|'assistant')는 내용이 있으면 **constant 깊이 엔트리**로 카드 로어북 끝(insertionOrder = 카드 엔트리 최댓값 + 1)에 붙고 `extensions`에서 빠진다 — 익스포트가 엔트리로 다시 쓰므로 왕복해도 두 번 생기지 않는다. `extensions.regex_scripts` 중 표시 전용(`markdownOnly`, `promptOnly`·`disabled` 아님, `placement`에 AI 출력 2 포함)만 RisuAI 것 뒤에 `displayScripts`로 붙는다: `findRegex`는 `/패턴/플래그` 또는 맨 패턴, `replaceString`의 `{{match}}`·`$0` → `$&`, `trimStrings`는 버린다. 패턴 검사(§8.1)에 걸리면 그 스크립트만 건너뛰고, 같은 in/out이 이미 있으면 넣지 않는다. `regex_scripts` 자체는 왕복을 위해 `extensions`에 남는다.
- `card/png.ts` — tEXt 청크 파서(`readPngTextChunkBytes`는 입력에 대한 뷰로, `readPngTextChunks`는 문자열로)·제거기와 작성기(`insertPngTextChunks`, CRC32를 직접 계산해 IEND 바로 앞에 넣는다), 그리고 그림 없는 카드용 크림색 자리표시 PNG(`placeholderPng`, fflate로 IDAT를 만든다).
- `card/charx.ts` — fflate로 필요한 엔트리만 세 패스로 해제한다. 1패스에서 `card.json`, 2패스에서 RisuAI의 `module.risum`, 3패스에서 카드가 선언한 아이콘(`type==='icon' && name==='main'`)과 **임베드 이미지 에셋 전부**(카드 순서, 50개 캡)를 한 예산 안에서 읽는다. 반환은 `{raw, module?, iconBuffer?, assets}`이고 임포트가 에셋을 slug화해 `plot_assets`로 저장한다.
  - **RisuAI의 charx 익스포트는 스크립트를 `card.json` 밖에 둔다.** `extensions.risuai`의 `customScripts`·`triggerscript`를 지우고 루트 엔트리 `module.risum`(`card/risum.ts`)에 실으며, RisuAI 임포트가 다시 합친다. 그래서 `parse.ts`가 모듈의 `regex`·`trigger`를 카드 사본의 그 두 자리에 넣고(카드에 이미 리스트가 있으면 그대로 둔다) 그 사본을 정규화한다 — `raw`도 합쳐진 카드다. 두 엔트리에 나뉘어 왔을 뿐 아카이브가 실어 온 카드가 그것이기 때문이다. `editdisplay`는 기존 `risu.ts` 경로로 `displayScripts`가 되고, 나머지(editoutput/editprocess/트리거)는 실행하지 않고 왕복용으로 `extensions`에 남는다. 모듈의 로어북은 버린다 — RisuAI가 같은 엔트리를 `character_book`으로도 쓴다.
  - **모듈은 자기 패스에서 혼자 읽는다.** 모듈이 무엇이든 임포트를 실패시키면 안 되는데, RisuAI는 에셋 → `module.risum` → `card.json` 순서로 쓴다. 1패스에 넣으면 캡을 넘는 모듈이 패스를 끝내 `card.json`에 닿지 못하고, 에셋 패스에 넣으면 앞선 그림들이 예산을 다 써 모듈에 닿지 못한다. 따로 읽으면 캡을 넘는 모듈은 그 패스를 빈손으로 끝낼 뿐이고, 인플레이트 오류는 잡아서 버린다. 대가는 아카이브를 한 번 더 훑는 것(해제는 모듈만)이다.
  - **아카이브의 50개와 플롯의 100개는 다른 상한이다.** charx 쪽 50은 파싱 예산 — 낯선 zip 하나가 프로세스에게 시킬 수 있는 일의 한도이며, 그래서 파서 안에 있다. 플롯 쪽 100(`MAX_ASSETS_PER_PLOT`)은 한 작품이 보유할 수 있는 이미지 수이고 업로드 경로에서 API가 집행한다. 카드 하나를 임포트해 만든 플롯은 최대 50개를 갖고 시작해 업로드로 100까지 채울 수 있으며, 추가 등장인물 카드를 임포트하면 남은 자리만큼만 그 카드의 에셋이 들어온다.
  - 하드닝: 엔트리당 20MiB, 16KB 슬라이스 단위 push. 선언 크기를 믿지 않고 인플레이터가 실제로 뱉은 바이트를 센다. 예산 초과는 그 자리에서 패스를 중단한다 — fflate 동기 인플레이터의 `terminate()`가 no-op이라 루프 break만이 실제로 일을 멈춘다.
  - **64MiB 총량 예산은 패스마다 따로 잡힌다.** 1패스의 `card.json`은 이름을 카드에서 알아낼 수 없고 그 자체가 카드라 자기 패스에서 혼자 풀리며, 2패스의 `module.risum`도 위의 이유로 혼자 풀린다. 둘 다 총량 예산이 아니라 엔트리 캡(20MiB)에만 걸린다. 3패스가 64MiB를 쓰고, 예산 초과 판정이 엔트리 경계가 아니라 청크마다 나므로 초과분 한 엔트리가 더 붙을 수 있다. 즉 **아카이브 하나의 최악치는 64MiB가 아니라 대략 `20MiB(card.json) + 20MiB(module.risum) + 64MiB + 마지막 엔트리`**다 — 코드 주석의 "이 예산 + 한 엔트리, 그 둘 위에"가 가리키는 것이 이것이다.
- `card/risum.ts` — RisuAI 레거시 모듈(`.risum`) 리더. 바이트 111(매직)·0(버전)·u32 LE 길이 L, 이어 L바이트의 RPack 인코딩 UTF-8 JSON `{type:'risuModule', module}`, 그 뒤 에셋 블록(`0x01`, u32 LE 길이, RPack 바이트)들과 끝의 `0x00`이다. 본 블록만 읽는다. RPack은 바이트 단위 치환이라 256바이트 디코드 표를 데이터로 싣고 디코더는 직접 썼다 — 표의 출처(RisuAI `src/ts/rpack/rpack_map.bin` 256–511바이트)와 RPack LICENSE의 "RisuAI 밖에서 쓰면 AGPL-3.0" 주장은 표 옆 주석에 남겼다(2026-10-10 소유자 결정). `readRisum`은 throw하지 않는다 — 읽을 수 없는 모듈은 undefined이고 카드는 모듈 없이 들어온다.
- V3 로어북 데코레이터: content 선행 `@@` 블록만 데코레이터로 보고 본문에서 분리한다. 지원 서브셋은 `@@depth N` / `@@role user|assistant|system`(depth와 함께일 때만 보존) / `@@constant` / `@@position before_desc|after_desc` / `@@activate_only_after N` → `delay` / `@@scan_depth N` → `scanDepth` / `@@keep_activate_after_match` → `sticky` 10000 / `@@dont_activate_after_match` → `cooldown` 10000(API 클램프의 상한이라 저장해도 그대로다) / `@@exclude_keys a,b` → 보조 키가 없고 정규식 엔트리가 아닐 때만 그 키들을 `not_any` 보조 키로(대소문자 유지). position이 있으면 스펙대로 depth를 무시하되, 값이 인식 불가면 position 자체를 무시하므로 depth가 살아남는다. 나머지 데코레이터와 `@@@` 폴백 체인은 해석 없이 strip.
- `card/export.ts` — NormalizedCard → V3 JSON. depth/role은 대응 필드가 없어 `@@depth`/`@@role` 라인으로 다시 직렬화하고, 10000 이상인 sticky·cooldown은 `@@keep_activate_after_match`·`@@dont_activate_after_match`로도 나간다. 그 밖의 고급 필드는 데코레이터로 쓰지 않고(본문을 깨끗이 두려고) **모든 엔트리에 ST 엔트리 `extensions`**(`position`·`depth`·`role`·`selectiveLogic`·`probability`+`useProbability`·`group`·`group_weight`·`scan_depth`·`sticky`·`cooldown`·`delay`·`case_sensitive`)로 쓴다 — ST가 읽는 자리이자 우리 임포트가 다시 읽는 자리다. 정규식 엔트리의 키는 `/패턴/`(대소문자 무시면 `i`)으로, 안의 `/`는 이스케이프해 나간다. 우리 확장은 `extensions.shizue.{componentCode, componentCapabilities}`로, RisuAI 호환 필드는 `extensions.risuai`로 나간다. 익스포트는 등장인물 한 명의 카드를 내되 플롯 차원의 것(`CardPlotOverlay`: 내레이터·커스텀 UI·도입부 — 첫째가 `first_mes`, 나머지가 `alternate_greetings`, 도입부가 없으면 카드 것 — ·플롯 로어북은 카드 엔트리 뒤에)을 되돌려 써서 **임포트가 감싼 것을 익스포트가 벗겨 낸다** — 카드가 왕복한다. `exportCardPng`는 그림(PNG가 아니거나 청크를 걸을 수 없으면 자리표시)의 텍스트 청크를 지우고 `chara`(ccardlib의 V3→V2 백필 — 스펙대로 데코레이터를 빼므로 깊이·역할은 ST 엔트리 확장으로만 남는다)와 `ccv3`를 싣는다.
- `worldInfo.ts`(`./world-info`) — `toWorldInfo(entries)`는 SillyTavern 월드 인포 파일(`{entries: {uid: {key, keysecondary, order, disable, position, …}}}`)을, `fromLorebookFile(json)`은 월드 인포 파일·CCv2/v3 `character_book`·그것을 담은 카드 JSON을 `LoreEntry[]`로 읽는다(그 밖은 `LorebookFileError`). 스튜디오가 브라우저에서 쓴다.
- `card/risu.ts` — RisuAI `customScripts` 중 `type==='editdisplay'`만 `displayScripts`로, `defaultVariables`(개행 `key=value` 블록 또는 객체)를 변수 시드로 매핑한다. `cardLicense`는 `extensions.risuai.license`(RisuRealm이 쓰는 `CC BY-NC 4.0`·`private` 따위)를 읽는다 — 빈 문자열은 "표기 없음"이라 `undefined`다. `extensions`가 원문 그대로 보존되므로 정규화된 카드에서 읽어도 된다.

### 매크로·변수

- `cbs.ts`(`./cbs`) — RisuAI CBS의 **공유 파서·평가기**. 프롬프트(`applyMacros`)와 표시 스크립트 템플릿(웹 `lib/cbs.ts`)이 같은 언어를 읽고, 출력이 어디로 가는지(이스케이프·표식·예산)는 호스트가 정한다. 중괄호는 RisuAI처럼 왼쪽부터 짝지어 **중첩**되고 안쪽부터 평가된다. 다만 RisuAI는 안쪽 결과를 바깥 매크로의 원문에 붙여 넣고 다시 읽지만 여기서는 **트리**라, 인자 경계(`::`)는 작성자가 쓴 것만 인정되고 값 속의 `::`·`{{`는 절대 구조가 되지 않는다. 식만 예외다 — `{{? $hp > {{getvar::max}}}}`는 RisuAI처럼 값이 붙은 텍스트로 계산되므로 값은 계산 결과만 바꿀 수 있다.
  - 블록: `{{#if X}}`(참 = 첫 단어가 `1`/`true`, 본문은 줄마다 앞 공백을 정리), `{{#if_pure X}}`(공백 유지), `{{#when X}}`·`{{#when::A::연산자::B}}`(RisuAI처럼 오른쪽부터: `not`·`and`·`or`·`is`·`isnot`·`>`·`<`·`>=`·`<=`·`var`·`vis`·`visnot`·`keep`·`legacy` — 전역 토글은 없으므로 `toggle`은 늘 꺼짐), `{{:else}}`. 닫기는 `{{/이름}}` 또는 `{{/}}`.
  - 함수: `getvar`, `calc`·`{{? …}}`, `equal`·`not_equal`(문자열 비교)·`greater`·`greater_equal`·`less`·`less_equal`(숫자 비교) — 결과는 `1`/`0`, `and`·`or`·`not`(`1`만 참), `sum`, `random`·`pick`(인자 여럿·JSON 배열·`,`/`:` 분할 목록), `roll`(`N`·`dN`·`XdY`, 주사위 100개 상한), `{{// …}}`. 이름은 RisuAI처럼 대소문자·공백·`_`·`-`를 무시한다(`greater_equal` = `greaterequal`). `::`가 없으면 `:`가 구분자다(`{{random:a,b}}`).
  - 식(`{{? }}`/`{{calc}}`)은 두 방언의 합집합: `$name`은 숫자로 읽는 변수(RisuAI, 없거나 숫자가 아니면 0), 맨이름은 텍스트로 읽는 변수(우리, `getvar::hp`도 같은 이름), `=`/`==`, `&`/`&&`, `|`/`||`, `!`, `^`, `≤≥≠`, 따옴표 문자열. **우선순위만 RisuAI와 다르다** — RisuAI는 `&`·`|`·비교를 한 단계로 묶어 `$a>1&$b<2`가 `(($a>1)&$b)<2`지만 여기서는 비교가 먼저다(실제 카드는 괄호를 쳐서 둘이 같다). 소수 잡음은 6자리에서 자르고 0으로 나누면 0이다.
  - **모르는 매크로는 인자까지 원문 그대로** 나가고 안쪽도 평가하지 않는다 — `{{setvar::x::{{getvar::y}}}}`가 히스토리에 그대로 남아 변수 폴드가 다시 읽는다. 이름이 다른 매크로로 조립된 매크로(`{{{{getvar::f}}::x}}`)도 모르는 것으로 친다 — 값이 어떤 함수를 돌릴지 고르게 두지 않는다.
  - 파싱은 관대(기본)와 엄격 둘이다. 관대하면 닫히지 않은 블록은 여는 매크로 원문, 짝 없는 닫기는 텍스트, 아무 닫기나 가장 안쪽 블록을 닫는다(RisuAI 동작). 엄격하면 셋 다 `CbsSyntaxError`다. 닫히지 않은 `{{`는 둘 다 텍스트. 깊이 상한은 블록 8, 매크로 16. RisuAI의 레거시 `{#if …#}` 블록, `#each … as`, 그 밖의 함수(`chat_index` 등)는 지원하지 않는다(원문 유지).
- `macro.ts` — `applyMacros`는 위 평가기에 프롬프트 호스트를 끼운 것이다: `{{char}}`, `{{user}}`, `{{original}}`(오버라이드 치환 전용), 시계 매크로 `{{date}}`·`{{time}}`·`{{weekday}}`·`{{idle_duration}}`, 챗마다 고정인 `{{pick}}`. 관대하게 파싱하고 throw하지 않는다. 변수(`MacroContext.variables`)가 없는 곳(챗 생성 시 도입부 확장)에서는 `getvar`와 식이 원문 유지이고, **그런 값에 기댄 `#if`/`#when` 블록은 통째로 원문 유지**다 — 거짓으로 읽혀 저장된 도입부에서 영영 빠지는 대신, 히스토리가 프롬프트로 확장될 때 그 갈래의 변수로 풀린다. **미지원 매크로는 원문 유지** — 이것이 `{{setvar}}`/`{{addvar}}`를 프롬프트 히스토리에 남겨 모델이 자기 프로토콜을 계속 관찰하게 하는 장치다.
- **`{{char}}`는 글의 출처마다 다르게 풀린다.** 등장인물 카드 안의 글(설명·성격·예시 대화·그 카드의 로어)에서는 그 등장인물의 이름이고, 그 밖의 모든 곳 — 프리셋, 플롯의 세계관 설정과 로어, 내레이터, 도입부, 히스토리 — 에서는 **플롯 이름**이다. 로스터가 여럿인 작품에서 프리셋의 "{{char}}의 등장인물"이 말이 되는 것이 이 규칙이다. `{{user}}`는 종전대로.
- `stripImageMacros` — `{{img::…}}`와 RisuAI의 나머지 에셋 매크로(`image`·`asset`·`emotion`·`raw`·`path`·`bg`·`bgm`·`audio`·`video`·`video-img`·`inlay`·`source`)는 클라이언트 마크업이라 프롬프트 조립에서만 제거한다 — 블록 안, 다른 매크로의 인자 안, 이름이 조립된 것까지. 저장 메시지와 인사 확장에는 남는다. `imageMacroRefs`는 글이 가리키는 그림(slug 또는 카드의 원래 이름, 조립된 것은 제외)이고, `assetResolver`가 참조를 slug로 푼다: slug 그대로 → 카드가 붙인 이름(RisuAI처럼 대소문자 무시) → 양쪽 다 이미지 확장자를 뗀 것 → 임포트가 접었을 slug(API `normalizeSlug`와 같은 규칙). RisuAI의 편집 거리 근사 매칭은 하지 않는다 — 틀린 그림이 없는 그림보다 나쁘다. 웹 렌더러와 챗 익스포트가 같은 규칙을 쓴다.
- **시계 매크로**는 `MacroContext.clock`(`{now, timeZone, locale, idleMs?}`)이 있을 때만 풀리고, 없으면 원문 그대로다. `Intl.DateTimeFormat(locale, {timeZone})`으로 `date` = `dateStyle: 'long'`, `time` = 24시간제 `HH:mm`(`hourCycle: 'h23'` — ICU 판마다 `timeStyle: 'short'`의 한국어가 "오후 3:36"과 "PM 3:36"으로 갈려서다), `weekday` = `weekday: 'long'`. locale은 플롯의 콘텐츠 `language`, 시간대는 웹이 보낸 `x-shizue-tz` 헤더다(§7.2). `{{idle_duration}}`은 `idleMs`를 그 언어로 쓴다 — 1분 미만이거나 값이 없으면 "방금"/"just now"/"たった今", 그 이상은 분·시간·일 중 가장 큰 단위의 정수(`Intl.NumberFormat`의 unit 서식, "3일"/"3 days"/"3 日").
- `{{pick}}`은 `{{random}}`과 같되 **챗마다 고정**이다. 인덱스가 `${seed}\0${원문}\0${매크로 위치}`의 FNV-1a 해시에서 나오고 seed는 챗 id다 — 같은 글의 같은 자리는 재생성해도 같은 것을 고르고, 한 글 안의 두 `{{pick}}`은 따로 고른다. seed가 없으면 `{{random}}`처럼 동작한다.
- **캐시 주의**: system 문자열(캐시 프리픽스)에 분 단위로 바뀌는 매크로(`{{time}}`·`{{idle_duration}}`)를 쓰면 프리픽스가 매분 달라진다. 크리에이터 가이드가 이것들을 depth 로어에 두라고 권하는 이유다.
- `variables.ts` — 경로 파생 변수. **저장 컬럼이 없다**: 값은 현재 브랜치 메시지의 `{{setvar}}`/`{{addvar}}`를 오래된 순으로 접어서 얻는다. 트리가 append-only라 스와이프·포크가 자동으로 그 브랜치의 상태를 낸다. 모든 맵은 null 프로토타입이고 읽기는 own-property로만 한다 — 변수 이름은 모델 출력과 남의 카드에서 오므로 `__proto__`·`toString`이 실제로 들어온다.

### 로어북

`lorebook.ts` `activateLore(entries, {history, scanDepth, budgetTokens, countTokens, recursiveScanning?, timed?, random?}) → {entries, triggered}`:

- 스캔 텍스트 = 히스토리 원문(최신이 마지막) 중 최근 `scanDepth`개의 연결. 엔트리에 `scanDepth`가 있으면 그 엔트리만 자기 깊이로 스캔한다 — 0이면 재귀로 덧붙은 텍스트만 보고, constant는 그래도 활성이다.
- constant는 무조건 활성. selective면 keys 1개 이상 매칭에 더해 secondaryKeys를 `selectiveLogic`으로 따진다: `and_any`(1개 이상 — 기본이자 필드 이전의 유일한 동작) / `and_all`(전부) / `not_any`(하나도 없음) / `not_all`(전부는 아님). useRegex면 key를 정규식으로, 아니면 부분 문자열(caseSensitive 반영).
- 로어북 정규식은 RE2JS의 선형 시간 엔진으로 실행한다. 키당 512자까지 지원하며, 잘못된 패턴·역참조·전방 탐색 등 지원하지 않는 문법과 길이 초과 키는 활성화하지 않는다. JS 정규식으로 폴백하지 않는다. 가져온 카드가 서버의 정규식 역추적으로 이벤트 루프를 멈추지 못하게 하는 경계다.
- insertionOrder 오름차순 정렬 후 tokenBudget 내로 컷.
- 재귀 스캔(카드 `recursive_scanning`, 기본 false): 1패스에서 활성화된 content를 모든 엔트리의 스캔 텍스트에 덧붙여 최대 2회 추가 스캔. constant는 첫 패스만, 이미 활성인 엔트리는 후속 패스 제외라 상호 트리거도 각 1회. tokenBudget은 전 패스 합산이고, 어느 패스든 예산이 모자라 잘리면 거기서 재귀도 끝난다. 반환은 마지막에 insertionOrder로 재정렬한다.
- **확률**(`probability` 0–100, 없으면 100): 새로 걸린 엔트리마다 한 번 굴린다(SillyTavern처럼 constant도). 실패한 엔트리는 이번 활성화에서 끝이고 기록되지 않는다. 100 이상이거나 없으면 굴리지 않는다.
- **포함 그룹**(`group`, 쉼표로 여럿, `groupWeight` 기본 100): 한 패스에서 확률을 통과한 엔트리 가운데 같은 그룹 라벨을 가진 것들은 가중치 추첨으로 하나만 남는다. 이번 활성화에서 그 그룹을 이미 가진 엔트리(지속 중인 것, 앞 패스에서 들어간 것)가 있으면 그것이 이기고 새 것들은 빠진다. 여러 그룹에 속한 엔트리는 하나라도 지면 빠진다. 굴림과 추첨은 주입 가능한 `random`을 쓴다.
- **시한 효과**(SillyTavern 의미론): 호출자가 `timed = {chatLength, lastTriggered}`를 준다. chatLength(g)는 생성될 메시지의 경로 인덱스(= 그 앞 메시지 수), lastTriggered는 `loreEntryKey` → 그 키를 `lore_triggers`에 담은 가장 최근 assistant 메시지의 인덱스(i)다. 메시지는 user·assistant를 가리지 않고 센다.
  - `delay` D: g < D인 동안 발동하지 않는다.
  - `sticky` S: `g - i <= S`인 동안 스캔·확률 없이 활성이고, 새 발동으로 세지 않는다(기간이 갱신되지 않는다).
  - `cooldown` C: `i + S < g <= i + S + C`인 동안 발동하지 않는다(S는 그 엔트리의 sticky, 없으면 0).
- **엔트리 키** `loreEntryKey(entry)` = `JSON.stringify([keys, secondaryKeys, content])`의 FNV-1a 16진수. 순서를 바꿔도 유지되고 엔트리를 고치면 바뀌어 시한 상태가 초기화된다(ST가 편집된 엔트리의 효과를 지우는 것과 같다). 기록은 지금 합쳐진 로어북에 **있고 enabled인** 엔트리에만 작용한다 — 지워졌거나 꺼졌거나 고쳐진 엔트리의 옛 기록은 효과가 없다.
- 반환의 `triggered`는 이번에 **새로** 발동해 실제로 프롬프트에 들어간 엔트리의 키다(재귀로 들어온 것 포함, 지속으로 넘어온 것·예산에 잘린 것 제외). 조립기가 `loreTriggers`로 돌려주고 apps/api가 새 assistant 메시지에 저장한다(§7.2).

**한 권으로 합쳐진 로어북**: 조립기가 `plot.lorebook` 뒤에 **모든 등장인물 카드의 로어북**을 이어 붙여 한 번에 활성화한다. 전 층이 하나의 토큰 예산을 나눠 쓰고, `activateLore`의 전역 insertionOrder 정렬이 병합 결과를 하나의 로어북으로 취급한다(정렬이 안정적이라 동점은 플롯이 먼저, 그다음 로스터 순서). 깊이·예산 설정(`loreSettings`)은 **첫 등장인물 카드의 것**을 쓴다 — 한 권이면 그것을 정하는 설정도 하나여야 하고, 오버라이드를 읽는 카드와 같은 카드다.

### 발화 프로토콜 (`speech.ts`)

누가 말하는지는 스키마가 아니라 **콘텐츠 규약**이다. 프리셋이 모델에게 이 형식을 가르치고(아래), 파서가 같은 형식을 읽고, 저장되는 것은 여전히 평문 한 덩어리라 메시지 트리의 분기·스와이프·수정이 전부 그대로 동작한다. `@:` 나레이션(`narration.ts`)과 `*지문*`이 이미 그런 규약이었고 이것이 그 연장이다.

- `parseAssistantSpeech(content, roster)` — `이름: ` 접두 줄(정규식 `^([^:\n]{1,40}):\s?(.*)$`, 이름은 로스터와 trim 후 **완전 일치**)은 그 등장인물의 블록, 접두사 없는 줄은 내레이터의 상황묘사. 같은 화자가 연속하면 한 블록으로 합쳐지고, 빈 줄은 여백일 뿐 블록을 끊지 않는다. 로스터에 없는 접두사는 손대지 않는다 — 그 줄은 콜론까지 포함해 내레이터 텍스트로 남는다. 화자 줄 안의 `*…*`가 그 인물의 상황묘사이고 나머지가 입 밖에 낸 말이며, 짝이 맞지 않는 `*`는 그냥 글자다.
- `parseUserSpeech(content)` — 턴 전체가 `@:`면 유저가 쓴 내레이터 상황묘사, 아니면 유저 블록 하나(`*…*`가 유저의 상황묘사). 유저 턴은 화자로 쪼개지지 않는다 — 한 턴은 한 목소리다.
- 순수 함수이고 예산이 필요 없을 만큼 싸서 **렌더마다 다시 돌린다**. 스트리밍 중 반쯤 쓰인 마지막 줄은 지금 말하는 대로 파싱되고 나머지가 도착하면 달라진다.
- 대가는 나레이션 규약이 치르는 것과 같다 — 대사가 하필 다른 등장인물의 이름으로 시작하면 그 인물의 말로 읽힌다. 규약이 규정대로 동작하는 것이지 탐지할 사례가 아니다.
- 익스포트는 이 접두사를 **그대로** 싣고 로스터를 함께 보낸다(§9.2) — 소비자가 누구의 줄인지 알아볼 수 있는 근거가 그것이다.

### 프롬프트 조립

`prompt.ts` `assemblePrompt(input) → { system, messages, loreTriggers }`. 입력은 **플롯 하나 + 로스터 전체**(`{plot: {name, description, lorebook, narrator}, characters: [{name, card}]}`, 카드가 아니다).

system 문자열(= 캐시 프리픽스, 순서대로 비어있지 않은 것만):

1. main — 프리셋의 main. **첫 등장인물 카드**의 `systemPrompt`가 있으면 그것으로 대체하되 `{{original}}`에 프리셋을 주입(플롯 차원의 오버라이드 필드는 아직 없다)
2. 나레이션 규약 한 줄 — `[나레이션]` 표시가 화자의 발화가 아니라는 설명. 매 턴 같은 문장이라 캐시 프리픽스에 한 번만 둔다
3. 로어북 `before_char`
4. 작품 블록 — `[작품: 이름]` + description
5. 등장인물 블록 — `order_index` 순으로 한 명당 하나: `[등장인물: 이름]` + description + (있으면) `{{char}}의 성격: ` + personality. **카드의 `scenario`는 읽지 않는다**. 장면에서 뺀 멤버(`PromptCharacter.absent`)는 블록도 예시 대화도 카드 로어북도 없고, 대신 남은 블록들 **바로 뒤에** `현재 장면에 없는 인물: A, B — 이 인물들은 이번 장면에서 대사나 행동으로 등장하지 않습니다.` 한 줄(`absentCastLine`)이 선다 — 카드는 빠져도 히스토리에는 그 이름이 가득해서, 이 줄이 없으면 모델이 계속 그 인물을 쓴다. 첫 멤버가 빠져도 **작품의 대리인은 그대로 첫 멤버다**(시스템 프롬프트·post-history 오버라이드와 로어 설정) — 그것들은 그 멤버의 말이 아니라 작품의 것이기 때문이다
6. 내레이터 블록 — `나레이터 문체: ` / `나레이션 시점: `. 챗 오버라이드가 있으면 그것, 없으면 플롯의 것
7. 스타일 블록 — `연출 지시:` + 설정된 옵션마다 한 줄(`styleDirectives`, 아래). 내레이터 **바로 뒤**, `after_char` 로어 **앞**이다 — 둘 다 "어떻게 쓸지"라 붙어 있어야 한 덩어리의 연출 지시로 읽힌다
8. 로어북 `after_char`
9. persona — `유저({{user}}) 정보: ` + personaText
10. memory — `[지난 이야기 요약]` / `[기억]` 블록
11. relationship — `[현재 관계 상태]` 블록

messages 배열:

```
[게임 판정] system 블록(마지막 유저 턴의 directions가 있을 때)
예시 대화 (등장인물마다 mesExample을 <START>로 분할, 블록마다 [예시 대화: 이름] 머리)
히스토리 (depth 로어와 author's note가 깊이대로 끼어든다)
post-history system 블록  ← 첫 등장인물 카드의 postHistoryInstructions로 대체 가능
```

- **예시 대화의 머리는 블록마다 붙는다.** 한 사람의 블록들 앞에 소개 한 줄을 두는 방식이 아닌 이유는 탈락 순서에 있다 — 블록은 히스토리가 남긴 예산에서 하나씩 떨어져 나가므로, 소개 한 줄만 두면 그 줄이 소개하려던 예시를 전부 잃고도 살아남는다.

- **directions가 system 문자열 밖에 있는 이유**: 턴마다 바뀌므로 캐시 프리픽스를 무효화하면 안 된다. 마지막 유저 메시지의 directions만 주입한다 — regenerate·continue는 같은 턴을 다시 쓰는 것이라 같은 판정을 다시 적용하고, auto는 그 턴 너머의 비트라 주입하지 않는다. 히스토리 텍스트에는 절대 들어가지 않는다.
- **예산**: 탈락하지 않는 것(system, post-history, directions, author's note, depth 로어)을 `contextBudget - maxResponseTokens`에서 먼저 뺀다. 남은 예산으로 히스토리를 **최신부터 역순으로** 채우고(가장 최신 메시지는 항상 남긴다), 그러고 남은 것으로 예시 대화를 채운다. 결과적으로 **탈락 순서는 예시 대화 → 오래된 히스토리**이고 author's note와 post-history는 탈락하지 않는다.
- **depth 로어**: `depth`가 있는 엔트리(`@@depth`·SillyTavern의 at-depth·캐릭터 노트로 들어오거나 스튜디오에서 지정)는 system 블록이 아니라 히스토리 구간에 `{role, content}`로 들어간다. depth 0 = 마지막 메시지 뒤, depth N = 끝에서 N번째 앞, 히스토리보다 깊으면 시작으로 clamp. 같은 지점에 여럿이면 insertionOrder 순. 로어북 자체 예산과 별개로 contextBudget에서도 선차감한다 — depth 로어는 히스토리를 밀어낸다.
- **author's note**(챗 노트 + 첨부 노트)는 히스토리 끝에서 `AUTHOR_NOTE_DEPTH` = 4(SillyTavern 기본값) 깊이에 system 메시지로 들어간다. 삽입 인덱스는 depth 로어와 같은 계산이고(trailingTurns 포함), 같은 지점에 depth 로어가 있으면 로어가 먼저(insertionOrder 순), 노트가 그다음이다. 히스토리가 4개보다 짧으면 그 시작으로 clamp된다. 히스토리 앞이 아니라 끝 가까이 두는 이유는 그것이 다음 턴을 이끄는 지시이기 때문이다 — 멀수록 모델이 덜 따른다. 예산에서는 종전대로 선차감되고 탈락하지 않는다. 설정이나 UI는 없다.
- **trailingTurns**: 호출자가 조립 결과 *뒤에* 직접 붙이는 턴 수. 이어쓰기에서 apps/api가 부분 assistant 메시지를 post-history 뒤에 재부착하므로 1을 넘긴다. 삽입 인덱스는 `min(len, max(0, len + trailingTurns - depth))`이고, trailing보다 얕은 depth는 히스토리 블록 끝으로 clamp된다(prefill 뒤에는 아무것도 올 수 없다). trailing 턴의 토큰은 조립기가 보지 못하므로 호출자가 `contextBudget`에서 빼서 넘긴다.
- 모든 텍스트에 매크로 적용. 시계와 `{{pick}}` seed는 입력의 `clock`/`seed`로 받아 플롯·등장인물 매크로 컨텍스트 전부에 싣고, 로어의 시한 상태는 `loreState`로 받는다(호출자가 전체 브랜치에서 만든다). 토큰 카운트는 `tokens.ts` — `js-tiktoken` o200k_base 단일 인코더 근사.
- **리포트**(`report: true`일 때만 — 생성 경로는 켜지 않는다): 결과에 `PromptReport`가 붙는다. `blocks`는 모델이 읽는 순서대로의 조각 `{kind, label?, tokens, text}`이다 — system 문자열의 섹션들(합치면 정확히 `system`)에 이어 messages 하나당 하나(`directions`·`examples`·`history`·`depth_lore`·`author_note`·`post_history`, 히스토리는 턴마다 따로라 끼어든 depth 로어와 노트의 자리가 보인다). `totals`는 `{contextBudget, responseReserve, used}`이고 `used`는 예산이 실제로 내준 양(탈락하지 않는 것 + 남은 히스토리·예시, 이미지 추정치 포함)이다. `history`/`examples`는 `{included, total}`, `lore`는 활성화된 엔트리마다 `{key, source('plot' | 멤버 이름), keys, preview(80자), placement('before_char' | 'after_char' | 'depth N'), via}` — `via`는 `activateLore`가 돌려주는 경위(`constant` | `keyword` | `sticky` | `recursion`)다. 블록마다 토큰을 다시 세므로 꺼져 있을 때는 비용이 없다.

### 스타일 지시문 (`style.ts` + `prompt.ts`)

크리에이터가 스튜디오에서 고른 연출 옵션(`plots.style`, §5)이 모델이 읽는 지시문이 되는 경로다. 타입과 화이트리스트는 `packages/core/src/style.ts`(`PlotStyle`, `coercePlotStyle`), 문장은 `prompt.ts`의 `styleDirectives(style)`에 있다.

- **기본값은 아무 말도 하지 않는다.** `balanced`·`natural`·`normal`·`auto`·`off`와 미설정 시제/스토리텔링은 줄을 만들지 않는다 — 크리에이터가 건드리지 않은 항목에 모델의 주의를 쓰지 않기 위해서다. 전부 기본값이면 `styleDirectives`는 빈 문자열을 돌려주고 system 문자열에 슬롯 자체가 없다.
- 옵션 한 줄씩: 시제(과거/현재) · 응답 길이(아래) · 표현 방식(대사/행동 비중을 "조금 더", 강제가 아니다) · 전개 속도 · 난이도(쉬움~악몽, 등장인물이 {{user}}를 대하는 태도로 쓴다) · 분위기(최대 2, 한국어 라벨은 `PLOT_MOOD_LABELS`) · 스토리텔링 문체 8종(작가 이름이 아니라 문체 묘사다) · 상태창 · 선택지.
- 지시문에도 매크로가 살아 있어 조립기가 다른 블록과 같이 확장한다. 프리셋과 같은 조사 규칙이 걸린다 — `{{char}}`/`{{user}}` 치환 뒤에 이형태 조사(을/를, 은/는)를 붙이지 않는다(`prompt.test.ts`가 전 문장을 고정한다).
- `coercePlotStyle`은 내레이터와 같은 태도다: 모르는 열거값은 **거부가 아니라 제거**, 분위기는 중복을 지우고 2개로 클램프, 남는 것이 없으면 `{}`. 이 빌드에 지시문이 없는 값이 컬럼에 들어가 조용히 무시되는 일이 없다. 기본값과 같은 값(`balanced`·`normal` 등)은 코어가 지우지 않는다 — 크리에이터가 고른 것이고, 줄을 만들지 않는 것은 컴파일러 쪽 사정이다. 컬럼을 비우는 것은 에디터의 몫이다(§5).

**응답 길이는 지시문과 상한의 짝이다.** 지시문만으로는 붙들리지 않는다 — 두 문단을 부탁받은 모델은 장면이 부추기면 다섯 문단을 쓴다(레퍼런스 서비스의 "짧음이 안 먹힘"이 이것이다). 우리는 조립도 요청도 직접 하므로 같은 설정이 양쪽을 정한다: 지시문이 목표를 말하고 `maxTokens`가 천장을 잡는다(`replyLengthTokens`, `generation.ts`가 요청에 싣는다).

| 응답 길이 | 지시문 | `maxTokens` |
|---|---|---|
| `short` 짧게 | 군더더기 없이 1~2문단 | 600 |
| `medium` 보통 | 읽기 편한 2~3문단 | 1200 |
| `long` 길게 | 3~5문단의 장문 | 2400 |
| `auto` 자동 · 미설정 | 없음 | 1200 |

`DEFAULT_MAX_RESPONSE_TOKENS`는 **1200 그대로다** — 길이를 고른 적 없는 플롯은 예전과 똑같은 상한으로 생성된다. 조립기의 예산도 같은 값을 본다: `generation.ts`가 프로바이더 요청의 `maxTokens`와 `assemblePrompt`의 `maxResponseTokens`를 **같은 `replyLengthTokens` 호출로** 채우므로, 예산이 비워 두는 응답 자리는 언제나 스트림이 실제로 쓸 수 있는 만큼이다 — `long`인 작품의 히스토리가 자기 응답 자리를 파먹은 채 조립되는 일은 없다.

### 상태창·선택지 규약

발화 프로토콜과 같은 층의 **콘텐츠 규약**이다. 스타일 지시문이 모델에게 형식을 가르치고, 코어의 파서가 같은 형식을 읽고, 저장되는 것은 여전히 평문 한 덩어리다 — 컬럼도 스키마도 늘지 않으므로 트리·스와이프·수정·내보내기가 전부 그대로다.

- **상태창**(`statusBlock.ts`) — 응답 끝의 `` ```status `` 코드 펜스, 안은 `키: 값` 한 줄씩(키는 모델이 장면에 맞게 고른다). `extractStatusBlock(content) → {body, status}`는 **턴이 실제로 끝나는 펜스만** 떼어 낸다: 뒤에 공백 아닌 무엇이라도 있으면 그 펜스는 인용이거나 지나간 상태이므로 본문에 남는다. 마지막 줄이 닫는 펜스일 때 위로 걸어 올라가 가장 가까운 펜스 구분선이 `` ```status `` 여는 줄인지 확인하는 방식이라, 스트리밍 도중 아직 닫히지 않은 펜스는 지금 보이는 그대로의 텍스트로 남았다가 닫히는 순간 카드가 된다. `parseStatusEntries`가 첫 콜론에서 잘라 행을 만들고, 콜론이 없는 줄은 키 없는 값 한 줄이 된다.
- **선택지**(`choices.ts`) — 응답 맨 끝의 `>> ` 줄들. `extractChoices(content) → {body, choices}`는 **끝의 연속 구간만** 떼어 낸다(중간의 `>>`는 산문이다). 사이의 빈 줄은 여백으로 넘기고, `>> ` 뒤에 아직 아무것도 없는 줄은 선택지가 아니다 — 빈 버튼이 생겼다가 라벨이 바뀌는 일을 막는다.
- **추출 순서는 선택지 → 상태창 → 기존 파이프라인이다.** 지시문이 선택지를 상태창 블록 *뒤에* 붙이라고 가르치므로, 선택지를 먼저 떼어 내지 않으면 상태창 펜스가 "턴의 끝"이 되는 일이 없다. 둘 다 발화 파싱보다 앞이다 — 상태창도 선택지도 누가 한 말이 아니다.
- **첫 장면의 상태창은 도입부 텍스트가 낸다.** 크리에이터가 도입부 끝에 같은 펜스를 쓰면 그 도입부 루트가 렌더될 때 같은 카드가 그려진다. 별도 입력 칸을 두지 않은 이유가 이것이다 — 규약이면 어디에 쓰든 규약이다.
- **보내는 히스토리에서는 지난 상태창·선택지를 뗀다.** `assemblePrompt`가 히스토리의 assistant 메시지 가운데 **가장 최신 것을 뺀 전부**에서, 렌더러와 같은 순서로(`extractChoices` → `extractStatusBlock`, `.body`) 끝의 선택지와 상태창 펜스를 떼어 낸 뒤에 재고 싣는다. 가장 최신 assistant 턴은 그대로 간다 — 지금의 상태이자 형식의 본보기다. 지난 상태는 이미 대체된 것이라 매 턴 다시 읽힐 이유가 없다. 유저 메시지는 손대지 않고, 떼고 나면 아무것도 남지 않는 턴은 통째로 둔다. 저장 텍스트는 그대로다. **로어북 스캔은 원문을 읽는다** — 옛 상태창의 `위치: 왕궁` 줄은 여전히 로어를 건다. 이어쓰기에서는 부분 메시지가 조립기를 우회하므로 그 앞의 assistant 메시지가 '가장 최신'이 되고, 의도된 동작이다.

### 프리셋

`presets.ts`가 5종을 갖는다: `standard`(기본) / `novel`(소설체) / `concise`(담백체) / `literary`(문학체) / `screenplay`(대본체). 각 `{main, postHistory}`. 언어 규칙(상대방 언어 따라가기)·임퍼서네이션 금지·조사 규칙은 전 프리셋 공통. `chats.preset`이 선택을 들고, 알 수 없는 값은 기본으로 폴백한다. `GET /api/presets`는 id만 주고 라벨은 클라이언트 i18n이다.

- 프리셋이 프레이밍하는 화자는 한 인물이 아니라 **작품 전체**다("당신은 {{char}}의 등장인물 전원과 내레이터를 연기하는 작가입니다") — 프리셋 텍스트에서 `{{char}}`가 플롯 이름으로 풀리는 것이 이 문장을 성립시킨다.
- 발화 규약 문단(`SPEECH_PROTOCOL`)은 **한 곳에 한 번 쓰여 다섯 프리셋이 공유한다**. `speech.ts`가 파싱하는 것이 정확히 이 형식이라, 사본이 다섯 개면 렌더된 챗이 모델에게 시킨 것과 어긋날 길도 다섯 개가 된다. post-history 블록에는 같은 규약의 한 줄 요약이 들어간다.
- 규약이 가르치는 것: 인물의 말과 행동은 `이름: ` 줄에, 줄 안의 행동·표정은 `*별표 묘사*`로, 장면·배경은 접두사 없는 줄로. 한 응답에 여러 인물이 번갈아 나올 수 있고, 로스터에 없는 인물은 지어내지 않는다. 유저 대필 금지는 종전대로.

## 7. 생성 파이프라인 (apps/api)

### 7.1 모델 계층 (packages/llm)

```ts
interface LLMAdapter { stream(req: ChatRequest): AsyncGenerator<StreamDelta, StreamDone>; }
```

- `chatgptAuth.ts` — 상태 없는 OAuth: 동적 등록, S256 PKCE·state·nonce, 인가 URL, 콜백 검사, JWKS 기반 ID 토큰 검증, 교환·갱신·해제, 계정의 모델 카탈로그. 시도와 토큰은 호출자(API의 `chatgptAccounts.ts`, §4.1)가 보관한다. 발급 client ID는 접두사를 가정하지 않고 `dynamic_agent_client`만 거부한다. 카탈로그 항목의 `supported_reasoning_levels`(`{effort, description}` 객체 또는 문자열)와 `default_reasoning_level`을 `reasoningEfforts`/`defaultReasoningEffort`로 읽는다 — 소문자 단어(`/^[a-z]{1,20}$/`)만 받고, 없거나 쓸 값이 없으면 필드도 없다(추론 강도 셀렉트가 숨는다). 필드 이름은 Codex 클라이언트에서 가져온 것으로 실계정 응답으로는 확인하지 않았다(테스트 픽스처가 그 가정을 적어 둔다).
- `registry.ts` — 모델 목록·어댑터는 **요청한 사용자의 계정**(`ChatGPTAccount`: access token + 카탈로그)에서 나온다. 계정 공식 `/v1/models` 응답에서 `visibility: list`만 순서대로 제공하고 30초 캐시한다. 계정이 없으면 목록은 비고 어댑터는 `chatgpt_login_required`다. Echo는 `NODE_ENV=test` 전용이다.
- `chatgptResponses.ts` — OAuth Bearer로 공식 `/v1/responses`에 `store:false`, `stream:true`를 보낸다. 전체 히스토리를 앱이 제공하고 system 턴은 순서를 유지한 developer 턴으로 변환한다. 지원하지 않는 temperature·max_output_tokens는 보내지 않는다. `ChatRequest.reasoningEffort`가 있을 때만 `reasoning: {effort}`를 싣고, 추론 요약은 요청하지 않는다(크리에이터의 숨은 프롬프트를 바꿔 말할 수 있다). 응답 길이는 프롬프트 지시이며 stop 문자열은 로컬에서 적용한다. `response.completed` 전에는 성공으로 취급하지 않는다.
- 이미지 생성과 임베딩은 이 경로에서 지원하지 않으므로 실행 경로에서 제거했다. 과거 벡터 메모리의 정합성 테스트만 주입된 테스트 임베더로 유지한다. 계정 모델 메타데이터의 `input_modalities`가 image를 포함할 때만 첨부 이미지를 전송한다.
- 다른 제공자/API 키 폴백은 지원하지 않는다. 생성·초안·답장 추천은 요청한 사용자의 계정으로, 요약·관계 같은 배경 작업은 그 챗 소유자의 계정으로 호출한다. 기존 대화는 기록을 보존한 채 사용 가능한 모델로 변경한다.


### 7.2 생성

`generation.ts`가 messages / regenerate / continue / auto / narrate 다섯 경로의 공통 몸통이다.

1. `withGenerationSlot` — 유저당 동시 생성 1(in-memory Set). 이미 잡혀 있으면 **429 `generation_in_progress`**. 슬롯은 SSE 응답이 끝날 때까지 유지된다.
2. 계획 수립: 경로 로드 → 플롯 + 로스터(`order_index` 순 — 챗의 `absent_character_ids`에 든 멤버는 absent로 표시, §6), persona, memory/relationship 블록, author's note(챗 노트 + 첨부 노트 병합), 마지막 유저 턴의 directions, 경로 파생 변수, 프리셋, 챗별 contextBudget. 내레이터는 `chats.narrator ?? plots.narrator`.
   - **독자의 시계**(`requestClock`): 시간대는 웹이 생성 POST 다섯 개와 `POST /api/chats`에 싣는 `x-shizue-tz` 헤더(IANA 이름)이고, `Intl.DateTimeFormat`이 거부하는 값이나 헤더 없음은 `UTC`다 — 시계 매크로가 턴을 실패시키는 일은 없다. locale은 플롯 `language`. idle은 브랜치의 마지막 유저 메시지와 그 앞 메시지의 `created_at` 차이라, 다섯 경로 모두 같은 값이고 재생성해도 그대로다. `{{pick}}`의 seed는 챗 id.
   - **로어 시한 상태**(`loreStateOf`): 생성될 메시지 앞의 **전체** 브랜치 경로에서 키마다 마지막으로 기록된 인덱스를 모은다 — 기억이 잘라 낸 히스토리가 아니다. 브랜치는 전송이면 경로 + 방금 넣은 유저 턴, 재생성이면 **교체될 head를 뺀** 경로, 자동진행·나레이션이면 경로 그대로, 이어쓰기면 생성 중인 메시지가 head 자신이므로 head를 뺀 경로다(그 head의 기록이 직전 턴의 발동으로 읽히면 지속 엔트리가 잘못 켜지고 재사용 대기가 잘못 걸린다).
3. `assemblePrompt` 후 특수 꼬리를 붙인다: continue는 부분 assistant 텍스트를 post-history 뒤에 assistant 메시지로, auto는 "유저 개입 없이 장면을 이어간다"는 system 지시를 그 뒤에 붙인다. 둘 다 조립기를 우회하므로 토큰을 `contextBudget`에서 직접 뺀다. **auto의 지시문은 DB에 저장되지 않는다.**
   - **다음 화자**: 생성 POST 다섯 개가 받는 `focusCharacterIds`는 `이번 응답은 {이름들}의 대사와 행동을 중심으로 씁니다.`(`sceneFocusDirective`, 이름은 로스터 순)가 되어 같은 꼬리 system 지시에 **합쳐진다** — 모드의 지시(auto·나레이션 넛지)가 있으면 그다음 줄이다. 그 턴 하나의 요청이라 저장되지 않는다. 이어쓰기에서는 부분 텍스트 **앞**에 온다 — 모델이 이어 쓸 턴이 맨 끝에 남아야 하기 때문이다.
   - `inspectGeneration`은 같은 `buildRequestMessages`를 리포트와 함께 돌리고 거기서 멈춘다 — 어댑터도 persist도 없다. 꼬리 지시는 `trailing` 블록으로 붙고, 리포트의 `contextBudget`은 꼬리를 빼기 전의 챗 예산이다.
4. 스트림: `maxTokens`는 `replyLengthTokens(plot.style?.replyLength)`(§6 응답 길이 페어링 — 기본 1200), `stop: ["\n{userName}:"]`, temperature 미지정(gpt-5가 비기본값을 거부한다). 추론 강도는 계획이 아니라 `runGeneration`이 그 자리에서 챗 행의 `reasoning_effort`를 읽어, 지금 카탈로그가 그 모델에 그 값을 광고할 때만 `reasoningEffort`로 넘긴다 — 카탈로그에서 빠진 값은 저장된 채 보내지 않는다.
5. 완료 시 persist(신규 삽입 + head 이동, 또는 continue의 in-place append) — 신규 삽입은 그 프롬프트의 `loreTriggers`를 `messages.lore_triggers`에 함께 쓰고(없으면 null), continue는 쓰지 않는다 → **해금 평가**(§7.5) → `done` 이벤트 → **done 이후에** 배경 작업 스케줄.

SSE 형식:
```
event: delta   data: {"text":"..."}
event: done    data: {"messageId":"...","usage":{...},"unlockedAssetIds":["…"]}
event: error   data: {"message":"..."}
```

`unlockedAssetIds`는 **정말 열린 것이 있을 때만** 실린다 — 클라이언트는 필드의 존재로 축하할지를 정하고, 그 외 모든 턴의 payload는 예전 그대로다.

- 어댑터 예외(abort 아님) → `error` 이벤트 후 종료, **assistant 메시지는 저장하지 않는다**. 유저 메시지는 유지되어 head가 유저 메시지인 상태가 되고, `regenerate`가 재시도 경로다.
- 클라이언트 abort → 그때까지 받은 텍스트를 저장하되 아무 이벤트도 보내지 않는다(이미 생성된 작업이므로).
- **429와 409는 다른 것이다.** 429 `generation_in_progress`는 생성 요청이 슬롯에 막힌 것이고, `PATCH /api/chats/:id`의 409 `generation_in_progress`는 설정 변경이 진행 중 생성과 겹친 것이다. PATCH는 슬롯을 확인만 하지 않고 핸들러 동안 **잡고 있다** — 확인만 하면 그 await 사이에 옛 설정으로 생성이 시작될 수 있다.

### 7.3 배경 작업 — 기억

`memory.ts`. 응답이 끝난 뒤 fire-and-forget으로 돌고 자기 실패를 삼킨다. 챗당 in-flight 1개(guard).

- **롤링 요약**: 현재 경로 토큰이 `contextBudget × summaryThreshold`(기본 0.6)를 넘으면, 유지 꼬리가 예산의 40%(`KEEP_RATIO`)에 맞도록 오래된 메시지를 접는다(최소 2개는 남긴다). 연결한 ChatGPT 계정의 첫 번째 모델(연결이 없으면 배경 작업 off)에 [기존 summary + 탈락 구간]을 주고 재요약한다. anchor = 요약이 덮은 마지막 메시지 id. 타임아웃 60s.
- **주입**: anchor가 현재 경로에 있으면 `[지난 이야기 요약]` 블록으로 넣고 히스토리는 anchor 이후만 원문 포함한다. 경로에 없으면(브랜치 이탈) 요약과 그에 딸린 사실을 통째로 무시한다.
- **사실 추출/검색**: 현재 로컬 제품에서는 비활성화. 아래 알고리즘은 주입된 테스트 임베더에서만 검증한다. 요약과 같은 호출로 영구 사실을 최대 8개 JSON 추출 → 임베딩 → `memories` 저장. 생성 시 최근 유저 메시지를 임베딩해 pgvector 코사인 상위 N개(챗별 `retrievalCount`, 기본 5)를 `[기억]`으로 요약 블록 뒤에 붙인다. 최근 6턴·요약과 중복되는 것은 뺀다. **검색 범위는 챗 단위** — 같은 플롯의 다른 대화 기억이 새어 들어오면 롤플레이가 오염된다.
- **동시성(리비전 카운터)**: `chats.memory_revision`이 무효화 카운터다. 무효화 이벤트(assistant in-place 수정, continue의 append, `PUT /memory`)는 자기 쓰기와 같은 트랜잭션에서 revision을 올린다. 배경 갱신은 스냅숏 시점 revision을 캡처해 요약 쓰기(CAS `WHERE memory_revision = captured`)와 사실 삽입(`SELECT ... FOR UPDATE` 안에서 재검증) 양쪽에서 대조하고, 어긋나면 조용히 버린다(다음 턴 재시도).
- 수정된 메시지가 anchor이거나 그 조상이면(= 요약이 이미 덮은 구간) `chats.memory`를 비우고 그 챗의 `memories`를 전부 지운다 — 고친 내용이 낡은 요약 뒤에 가려지면 안 되고, 사실은 요약에서 파생된 캐시라 전량 폐기가 안전하다.

### 7.4 배경 작업 — 관계 스탯

`relationship.ts`. 메모리와 별도의 guard를 쓴다.

- 6축 `affection / obsession / trust / liking / disgust / fear`, 각 0~100 정수. 시작값은 `50/0/50/50/0/0` — 온기 축은 중립, 원인이 필요한 축(집착·혐오·두려움)은 0.
- **갱신 주기는 경로 깊이 기반**: 생성 이벤트를 세지 않고 완료 시점의 현재 경로 assistant 메시지 수를 `lastExtractedAssistantDepth`와 비교해 차이가 5 이상일 때만 추출한다. 재생성은 형제 교체, 이어쓰기는 in-place라 둘 다 깊이가 그대로 → 트리거되지 않는다. 추출은 **시작 시점에 읽은 깊이**를 기록하므로 도는 동안 완료된 턴도 다음 계산에 남는다.
- 브랜치 리베이스: 깊이가 기록값보다 작으면(더 짧은 분기) 값을 현재 깊이로 낮추고 추출은 건너뛴다. 수치 자체는 유지.
- 메모리 채널 모델에 최근 10턴 + 현재 수치를 주고 새 수치 + 한 줄 요약을 JSON으로 받아 서버에서 0~100 clamp. 타임아웃 30s. 파싱 실패·타임아웃은 무시하되 시도 깊이는 기록해 5턴 뒤 재시도한다.
- `relationship_enabled=false`면 모델 호출도 깊이 기록도 하지 않는다. 유저 편집 경로가 없으므로 리비전 프로토콜 없이 last-write-wins.
- 주입: enabled이고 axes가 있으면 system의 메모리 뒤에 `[현재 관계 상태]` 블록.

### 7.5 해금 평가

`unlocks.ts`. 배경 작업이 아니라 **턴의 일부**다 — 값싸고 동기적이며, 다섯 생성 경로가 공유하는 persist 직후 한 곳에서만 불린다(`generation.ts`의 `openUnlocks`).

- 후보는 "이 플롯의 `unlock`이 걸린 에셋 − 이 챗이 이미 연 것"이다. **플롯 소유자의 챗은 후보가 비어 있다** — 자기 작품의 그림은 이미 전부 열려 있다(`assetLocks`).
- 판정은 방금 영속된 assistant 텍스트에 대해 한다. keyword는 대소문자 무시 부분 문자열, turns는 현재 갈래의 assistant 깊이 ≥ count(그것을 기다리는 후보가 있을 때만 경로를 걷는다), relationship은 `chat.relationship.axes[axis] ≥ min`(axes가 null이면 언제나 거짓).
- 챗 행은 plan이 아니라 **DB에서 다시 읽는다**: head가 방금 움직였고, 턴 수 조건은 지금 서 있는 갈래에 대해 묻는 질문이기 때문이다.
- 실패는 로그만 남긴다. 텍스트는 이미 저장되었고, 열리지 못한 해금은 다음 턴이 다시 묻는다.
- **관계 해금만 지연 공개다.** 관계 추출은 `done` 이후에 도는 배경 작업(§7.4)이라, 턴이 방금 만들어 낸 수치는 그 턴의 평가 시점에 아직 행에 없다. 그래서 추출이 성공하면 `relationship.ts`가 **관계 종류만** 다시 평가한다(`unlockByRelationship`). 이 두 번째 평가에는 실어 보낼 스트림이 이미 없으므로 — 공개는 **그 챗의 다음 상태 읽기에 얹혀 나간다**. 임계값을 넘긴 바로 그 턴이 자기가 연 그림을 영영 못 여는 일을 막는 장치이고, 그 대가가 "한 박자 늦게 나타난다"는 것이다.

### 7.6 단발 호출 — 초안·답장 추천

생성 슬롯을 쓰지 않는 두 개의 비스트리밍 모델 호출이다. 둘 다 **아무것도 저장하지 않고**, 둘 다 JSON을 방어적으로 파싱해 **한 번 재시도**한다(모델이 JSON을 감싸거나 앞말을 붙인 경우가 이 재시도가 막는 실패다).

- **AI 플롯 초안** (`draft.ts`) — **기본 채팅 모델**(`listEnabledModels`의 첫 항목)에게 간다. 크리에이터의 글을 대신 쓰는 일이라 값싼 요약용 채널에 맡기지 않는다. 타임아웃 60s, 유저당 in-flight 1개(429 `draft_in_progress`). 모델이 하나도 없으면 503 `draft_unavailable`, 두 번 다 못 알아들으면 502 `draft_failed`. 답은 **생성 POST가 받는 필드 그대로**이고 서버는 저장하지 않는다 — 스튜디오가 평범한 `POST /api/plots`로 만든다.
- **답장 추천** (`suggest.ts`) — **메모리 채널 모델**에게 간다. 값싸고 잦고 버려지는 요청이라서다. 키가 없는 배포는 이 기능을 아예 제공하지 않는다(503 `suggestions_unavailable`). 현재 갈래의 마지막 10턴 + 페르소나 + 작품 이름으로 프롬프트를 만들고, 200자 이하의 독자 답장 후보 3개를 받는다. 타임아웃 20s, 챗당 in-flight 1개(429 `suggestion_in_progress`), 생성 중에는 429 `generation_in_progress`(제안할 대상인 턴이 아직 도착하지 않았다). 못 알아들으면 502 `suggestions_failed`.

## 8. 커스텀 UI와 게임 레이어

설계 근거·조사·잔존 리스크는 `docs/CUSTOM-UI-DESIGN.md`. 여기서는 구조만.

### 8.1 Layer 1 — 표시 스크립트 (RisuAI 호환)

- 플롯 필드 `custom_ui.displayScripts`: `{in(정규식), out(HTML 템플릿), flags?, order, action?, enabled}`. `move_top`/`move_bottom`은 매치를 메시지 상/하단으로 옮기고, `repeat_back`은 이번 메시지에 매치가 없으면 직전 동일 role 메시지의 매치를 재사용한다(상태창 유지).
- 적용은 **웹 렌더에서만**. 저장 텍스트도 프롬프트도 건드리지 않는다. `apps/web/src/lib/displayScripts.ts`가 예산(스캔 20,000자, 스크립트당 매치 200, 세그먼트 100, HTML 100,000자, 50ms 데드라인) 안에서 돌리고, 어느 하나라도 넘으면 변환을 통째로 버리고 플레인 텍스트로 떨어진다.
- **변환은 두 쪽으로 갈라져 있다**. 창작자 정규식을 실제로 돌리는 쪽(`planDisplayScripts` → "어디에 매치가 있는가"라는 순수 데이터)은 `lib/displayPlanner.ts`가 **종료 가능한 워커**에서 돌린다 — 단일 `exec`는 중단할 수 없고 협조적 데드라인은 그 경우 차례를 못 받으므로, 1,000ms 안에 답이 없으면 스레드를 끝내고 그 메시지는 평문이 된다. 매치를 마크업으로 바꾸는 쪽(캡처 바인딩 → CBS 템플릿 → 새니타이즈)은 DOM이 필요하므로 메인 스레드에 남고, 계획에는 바인딩이 들어가지 않으므로 변수가 바뀔 때의 재렌더는 왕복 없이 동기다. 계획은 정착한 메시지당 1회 요청하며, **스트리밍 중인 메시지에는 표시 스크립트를 적용하지 않는다**.
- OUT 템플릿 바인딩은 공유 CBS(`@shizue/core/cbs`, §매크로·변수)에 웹 호스트(`lib/cbs.ts`)를 끼운 것이다(클라이언트 평가, eval 금지). RisuAI의 중첩·블록·함수 전부에 더해 우리 방언 — `{{#if 식}}`(조건을 **매크로 없이 적으면** 맨이름 변수·`==`·따옴표 문자열의 식, **매크로를 넣어 적으면** RisuAI의 `1`/`true` 판정), `{{#each 목록}}`…`{{slot}}`, `{{rel::축}}`, `{{turn}}`, `{{char}}`, `{{user}}`, `{{button::라벨::입력텍스트}}`, `{{screen_width}}`(그린 시점의 창 너비). `{{button}}`은 입력창을 채우기만 하고 전송은 유저가 한다. 템플릿은 엄격 파싱이라, 거부되면 이스케이프된 원문으로 보인다.
  - **그림**: `{{img::X}}`·`{{image::X}}`·`{{asset::X}}`·`{{emotion::X}}`는 마크업의 **텍스트 자리에서는 `<img>` 요소**(RisuAI 카드의 `<div>{{img::face.png}}</div>`)이고, **태그 속성이나 `<style>` 안에서는 주소**(우리의 `<img src="{{img::slug}}">`·`url({{img::slug}})`)다. 자리는 템플릿 자신의 텍스트로만 판정한다 — 치환된 값은 이스케이프되어 `<`가 없으므로 모델이 자리를 옮길 수 없다. `{{raw::X}}`·`{{path::X}}`는 어디서나 주소, `bg`·`bgm`·`audio`·`video`·`video-img`·`inlay`·`source`는 버린다. X는 `assetResolver`로 풀고(§매크로·변수), 렌더 시점에 조립된 이름도 푼다(`{{img::{{getvar::outfit}}_1.webp}}`). 못 풀거나 이 챗에서 잠긴 그림은 빈 문자열이다. 메시지 본문(`MessageBody`)도 같은 별칭을 마크다운 이미지로 그리고(alt는 slug), 주소·미디어·조립된 참조는 버린다 — 본문에는 변수가 없다.
- **새니타이즈(신뢰 경계)**: `apps/web/src/lib/sanitizeHtml.ts`. ① `<style>`을 CSS AST(`@adobe/css-tools`)로 재작성 — 셀렉터를 `.shizue-msg` 아래로 스코프, 클래스를 `x-shizue-` 네임스페이스, 속성/함수 화이트리스트, 스코프 불가 at-rule 제거. ② DOMPurify 화이트리스트 패스. ③ DOM 패스 — 클래스 네임스페이싱, 인라인 style 재검사, `<img src>` same-origin 강제, 외부 `<a>`에 `target=_blank` + `rel=noopener noreferrer nofollow`. ④ 2차 DOMPurify. 절대 throw하지 않고 실패하면 빈 문자열.
  - **`href`는 모양이 아니라 최종값으로 판정한다**: 템플릿 엔진이 보간하는 값 중 모델이 고른 것(`{{getvar}}`·`{{calc}}`/`{{? }}`·`{{slot}}`·정규식 캡처)에 표식을 달고(`lib/taint.ts`), 보간이 끝난 `href`에 표식이 있으면 그 `<a>`는 링크가 아니라 텍스트가 된다 — 라벨은 남고 갈 뻔했던 주소가 옆에 찍힌다. RisuAI 함수(`equal`·`random`·`sum` …)는 읽은 인자에 표식이 있었으면 결과에도 단다. 그림 주소는 모델이 *어느* 그림인지 골랐어도 우리 에셋 주소라 달지 않는다. 표식은 나가기 전에 전부 제거된다.
- 뷰어 보호: localStorage 토글 하나로 표시 스크립트와 컴포넌트를 모두 끄고 `{{setvar}}`만 숨긴 플레인 렌더로 떨어진다.

### 8.2 Layer 2 — 샌드박스 컴포넌트

- 메시지 안의 호출 코드 `<ComponentName prop={...} />`(자기닫힘만)를 `lib/componentCalls.ts`가 리터럴 전용 파서로 뜯는다(평가 없음, 메시지당 8개 상한, 스트리밍 중 미완성 호출은 null). 표시할 때 호출 코드 원문은 숨기지만 LLM 히스토리에는 남는다.
- **실행 렘 = sandboxed iframe 안의 Worker**. `ComponentFrame`이 `sandbox="allow-scripts"`(`allow-same-origin` 없음 → 불투명 오리진)인 iframe을 `srcdoc`으로 띄우고, 그 프레임이 blob Worker를 만들어 **창작자 코드는 오직 워커에서만** 돈다. 워커에는 DOM도, 이동 가능한 location도, `RTCPeerConnection`도 없고 `terminate()`가 가능하다 — 차단이 아니라 부재로 해결한다.
- **번들 없음**: React도 Babel도 싣지 않는다. 자체 JSX 스캐너(`h()` 변환) + 자체 훅 런타임(useState/useEffect/useMemo/useCallback/useRef) + 서브셋 검사를 워커 안에서 돌린다(`lib/componentRuntime.ts`). 위험 전역은 워커 전역의 own 프로퍼티로 undefined 덮어쓰기.
- `@shizue/core/component`의 서브셋 검사(`componentSubsetViolations`)는 **보안 경계가 아니다** — 격리가 경계다. 이건 크리에이터가 에디터에서 서브셋 이탈을 미리 알게 하는 용도이고, 워커가 자립 사본으로 같은 규칙을 다시 적용한다.
- **워커→프레임 트리가 신뢰 경계**: 워커는 DOM이 아니라 직렬화 트리를 보내고, 프레임(우리 코드)이 그리기 전에 전체를 검사한다(`checkTree`/`setAttrs`). **여기는 화이트리스트가 아니라 기본 허용 + 블랙리스트다** — Layer 1의 DOMPurify와 혼동하면 안 된다.
  - 태그: 문법 검사(`TAG_RE`) + `FORBIDDEN_TAGS` 거부 목록(`script`/`iframe`/`object`/`embed`/`link`/`meta`/`base`/`form`/`template`/`slot` 등). 목록에 없고 문법이 맞는 태그는 통과한다.
  - 속성: 문법 검사(`ATTR_RE`) + `on*` 거부 + 속성형 `style` 거부 + `NAVIGATION_ATTRS`(`href`/`ping`/`target`/`download`/`formaction`/`action`/`xlink:href`) 전면 거부. URL을 실제로 물어오는 속성만 `safeUrl`로 스킴을 본다. 그 밖의 문법상 유효한 속성은 그대로 걸린다. CSS 속성명도 문법 검사만 한다.
  - **진짜 화이트리스트인 곳은 둘뿐**: 이벤트 이름(`EVENTS`)과 DOM 프로퍼티(`value`/`checked`).
  - 크기: 노드 5000·깊이 64 상한.
  - 이 배치가 성립하는 근거는 격리다 — 창작자 코드는 불투명 오리진의 워커 안에 있고 트리는 우리 프레임 안에서만 그려진다. 대조적으로 Layer 1의 `sanitizeHtml`은 **카드 텍스트를 우리 오리진에 직접 그리므로** DOMPurify의 `ALLOWED_TAGS`/`ALLOWED_ATTR` 실제 허용 목록을 쓴다.
- **응답성 예산**: 첫 렌더 2000ms / 이벤트 500ms / pong 500ms, 턴당 트리 32개 상한, 초과 시 `terminate()` + 폴백 카드. 턴 사이에는 **5,000ms 하트비트**가 유휴 워커에 계속 묻는다 — ping 하나에 답한 뒤 도는 컴포넌트가 다음 상호작용까지 스레드를 쥐고 있던 구멍이 이걸로 닫힌다. 데드라인이 이미 서 있는 틱은 아무것도 하지 않는다(안 그러면 5초마다 데드라인이 새로 깔린다).
- **브리지**(`lib/componentBridge.ts`): 부모↔프레임은 `MessageChannel` 포트로 말한다. 샌드박스 프레임은 `contentWindow` 동일성을 유지한 채 자기 내비게이션이 가능해서 윈도 채널로는 구분이 안 되지만, 포트는 문서와 함께 죽는다. `ready`는 한 번만 받고, 두 번째 `load`면 프레임을 폐기한다.
- 바인딩: 호출 코드 props + `platform` prop `{variables, relationship, turn, char, user, assets, suggestInput, sendTurn}`. 모델이 델타(`{{setvar}}`)만 출력해도 UI가 최신 상태를 반영한다.
- `ComponentCodeEditor`는 챗과 **같은 프레임·같은 런타임**으로 프리뷰한다.

### 8.3 대화 컴포넌트 턴

플롯이 `custom_ui.componentCapabilities: ['sendTurn']`을 선언해야만 컴포넌트가 유저 대신 턴을 보낼 수 있다. 게이트가 다섯이고, 앞의 넷은 전부 브라우저에 있다.

1. **플롯 미선언** → `ComponentFrame`에 `onSendTurn` prop 자체가 없고 브리지가 포트 메시지를 버린다.
2. **챗별 1회 동의** → `chats.allow_component_turns`(기본 false). 확인 후 `PATCH /api/chats/:id {allowComponentTurns}`로 저장하고, 노트 패널 체크박스로 회수한다.
3. **제스처 창(프레임)** → 사람 없이 도는 것을 막는 게이트. effect에서 `sendTurn`을 부르면 마운트마다 한 턴이고 챗은 모델 턴마다 재마운트하므로 둘이 영원히 주고받는다. 그래서 프레임은 **의도적인 DOM 이벤트가 연 1500ms 창 안에서만** sendTurn을 부모로 넘기고, 한 번 넘기면 창을 닫는다. 창을 여는 것은 `click`·`dblclick`·`keydown`·`keyup`·`mousedown`·`mouseup`·`input`·`change`뿐이다 — `mouseenter`/`mouseleave`·`focus`/`blur`는 컴포넌트에 **전달은 되지만**(호버·포커스 표현에 필요하다) 창을 열지 못한다. 정지한 포인터 아래에 노드가 새로 그려지면 `mouseenter`는 공짜로 발생하고 컴포넌트는 변수가 바뀔 때마다 재초기화되므로, 그러지 않으면 `onMouseEnter`에 `sendTurn`을 건 카드가 독자가 손을 대지 않아도 모델 응답마다 한 턴씩 가져갈 수 있다. 사람의 상호작용을 아는 렘은 프레임뿐이다 — 워커는 effect와 클릭 핸들러를 구분할 수 없고, 부모는 둘 다 못 본다.
4. **모델 턴당 1회(챗 페이지)** → `sendComponentTurn`이 `mode`(스트리밍 진행 중)나 `componentTurnRef`(동의 프롬프트를 포함한 컴포넌트 턴 처리 중)가 서 있으면 호출을 조용히 버린다. `mode`가 스트리밍 구간을, ref가 아직 아무것도 스트리밍되지 않는 동의 확인 구간을 덮는다 — ref가 없으면 두 번째 호출이 그 틈으로 빠져나간다.
5. **서버 재검증(권위)** → 위 넷은 전부 브라우저에 있고, 브라우저는 컴포넌트가 영향을 미치는 쪽이다. `source:'component'`인 POST는 서버가 **매 요청** ⓐ 챗 행의 `allow_component_turns` ⓑ 현재 플롯의 `custom_ui.componentCapabilities`를 다시 읽어 둘 다 참일 때만 받는다. 아니면 쓰기 이전에 403 `component_turns_not_allowed`. 다른 탭에서 동의를 회수하거나 크리에이터가 capability를 내리면 바로 다음 요청이 막힌다.

**stage directions**: `messages.directions`(≤800자)는 그 턴에 컴포넌트가 내린 판정이다. `POST /api/chats/:id/messages`가 `directions`를 유저 메시지에 영속하고, 신뢰 수준은 유저 입력과 동급이다(유저는 자기 챗 입력을 이미 완전 통제한다). 렌더되는 메시지 텍스트에는 절대 들어가지 않고, 프롬프트에는 §6의 `[게임 판정]` 블록으로만 들어간다.

**길이 상한은 층마다 다르게 동작한다** — 같은 규칙을 네 번 적용하는 구조가 아니다.

| 층 | 턴 텍스트 | directions |
|---|---|---|
| 워커 (`componentRuntime`) | 2,000자 절단 | 800자 절단 |
| 프레임 (`componentRuntime`) | 2,000자 절단 | 800자 절단 |
| 브리지 (`componentBridge`) | 2,000자 절단 | 800자 절단 |
| 서버 (`routes/chats.ts`) | 2,000자 **초과 시 400 `invalid_request`** (절단 아님, `source:'component'`에만) | 800자 **초과 시 400 `invalid_request`** (절단 아님) |

즉 클라이언트 세 층은 **자르고**, 서버는 **거부한다**. 정상 경로에서는 앞의 세 층이 이미 잘라 보내므로 이 400은 뜨지 않고, 브라우저를 거치지 않고 손으로 만든 요청에 대한 계약 검사로만 존재한다.

숫자의 주인은 하나다 — `@shizue/core`의 `MAX_COMPONENT_TURN_LENGTH`(2,000)와 `MAX_DIRECTIONS_LENGTH`(800). 워커와 프레임은 `Function.prototype.toString()`으로 문자열화되어 import가 살아남지 못하므로 `{turn, directions}` 인자로 받아 자르고(프레임이 자기 안에 인라인하는 워커 소스에도 같은 값이 이미 박혀 나간다), 브리지는 그 상수를 그대로 쓰며, 서버는 같은 상수로 거부한다.

**턴 텍스트의 상한은 `source:'component'`인 턴에만 걸린다.** 계약을 선언한 것은 프로그램이고, 사람이 입력창에 친 메시지 길이에는 예나 지금이나 상한이 없다.

## 9. 내보내기와 이미지 스토리지

### 9.1 챗 내보내기

형식과 권리 경계는 루트 `docs/PLATFORM.md`를 참조한다.
API는 `@shizue/contracts`의 스키마를 사용한다.

### 9.2 오브젝트 스토리지

`apps/api/src/storage.ts`의 `ObjectStorage`는 `put`, `get`, `delete`를 제공한다.
`get`은 `{body, size}` 또는 null이며 읽기는 스트림으로 처리한다.
드라이버는 `local` 또는 `s3`이고, 선택과 설정은 `env.ts`에서 부팅 때 한 번 읽는다.

아바타, 플롯 에셋, 커버와 독자 첨부 이미지는 각각 `avatars/`, `assets/`,
`covers/`, `attachments/` 네임스페이스를 사용한다. DB는 전체 키를 보관한다.
이미지 바이트는 API가 같은 오리진으로 서빙하며 각 라우트가 접근 권한과 MIME을 확인한다.
로컬 파일은 `UPLOAD_DIR` 아래에, S3 배포는 설정한 버킷에 저장한다.

## 10. HTTP 계약 (apps/api)

포트 8787, 모든 경로 `/api` 프리픽스. **라우트 등록의 권위는 `apps/api/src/app.ts`이고, 각 엔드포인트의 바디·쿼리 검증은 해당 `routes/*.ts`다.** 전체 목록을 여기 복제하지 않는다.

마운트와 인증 경계:

```
세션 미들웨어 앞:
  /api/auth/*            세션 조회·로그아웃 (test에서만 better-auth 픽스처)
  /api/presets           프리셋 id 목록          (유저별 정보 없음)
── 세션 미들웨어: 세션을 **요구하지 않고 해석**한다 ──
   있으면 c.viewerId = c.userId = 유저 id, 없으면 c.viewerId = null로 통과
── requireUser 가드(`apps/api/src/session.ts`)를 건 곳만 401 ──
  라우터 통째로:  /api/comments   /api/personas   /api/notes
                  /api/chats      /api/messages   /api/notifications
  가드 없이 viewerId로 답함: /api/chatgpt(로그인 시작·콜백·상태, 로그아웃만 가드)
                  /api/models(읽는 사람 계정의 모델, 비로그인은 [];
                              광고하는 모델만 reasoningEfforts·defaultReasoningEffort)
  라우트별로:     /api/plots(본체 + 댓글)
                  /api/creators(팔로우 두 라우트만)
  가드 없음:      /api/explore
```

**리소스 표면은 플롯 하나로 모였다.** `/api/characters`는 없다 — 등장인물은 자기가 속한 작품 아래에서만 주소를 갖는다.

```
/api/plots                          목록(내 것) · 생성
/api/plots/draft                    POST — 한 줄 설정 → 초안(저장하지 않는다, §7.6)
/api/plots/import                   카드 파일 → 카드를 감싸는 새 플롯(50MB, 선택 필드 sourceUrl)
/api/plots/:id                      소유자 뷰(전부) · PATCH · DELETE
/api/plots/:id/publish              발행/회수 + 세이프티 선언 + 임포트 멤버의 권리 확인(rightsConfirmed)
/api/plots/:id/public               익명 공개 뷰 (아래)
/api/plots/:id/cover                업로드 · 삭제 · 서빙(공개)
/api/plots/:id/like                 POST · DELETE
/api/plots/:id/comments             목록(공개) · 작성
/api/plots/:id/characters           로스터 목록 · 추가 · 재정렬(POST …/reorder)
/api/plots/:id/characters/import    카드 파일 → 등장인물 한 명 추가(50MB, sourceUrl · 공개 플롯이면 rightsConfirmed)
/api/plots/:id/characters/:cid      PATCH · DELETE · /avatar(업로드·삭제·서빙)
/api/plots/:id/characters/:cid/export?format=json|png
                                    소유자 전용 — 저장된 카드 + 플롯 오버레이를 V3 카드 파일로(첨부 다운로드)
/api/plots/:id/assets[/:slug]       목록·서빙은 공개, 업로드·삭제·PATCH(해금 조건)는 소유자
/api/explore                          공개 플롯 피드 (별도의 플롯 레일은 없다 — 탐색이 곧 플롯이다)
/api/creators/:id                     그 크리에이터의 공개 플롯 그리드 + 팔로우 상태
/api/creators/:id/follow              POST · DELETE (멱등, 자기 자신은 400)
/api/notifications                    내 알림 목록(커서) · POST /read(전부 읽음)
POST /api/chats {plotId, model, personaId?|profileId?, introIndex?}
POST /api/chats/:id/suggest           답장 후보 3개 (§7.6)
GET  /api/chats/:id/inspect           재생성이 지금 보낼 프롬프트의 리포트 — 작가 본인의 챗만 (아래)
```

익명으로 200인 GET은 **공개 콘텐츠뿐**이다: `/api/explore`, `/api/creators/:id`, `/api/plots/:id/public`·`/cover`·`/assets*`·`/characters/:cid/avatar`·`/comments`. 나머지는 전부 401이다 — 모든 mutation(좋아요·댓글 작성·챗·업로드·CRUD), `/api/plots` 목록(내 것)과 소유자 뷰, 페르소나·노트.

등장인물 아바타가 **플롯 아래 주소**인 것은 우연이 아니다. 등장인물은 자기 노출 축이 없으므로, 그 이미지를 누가 볼 수 있는지 답하는 유일한 행이 플롯이고 URL이 그 사실을 그대로 말한다.

익명 뷰어 규칙은 두 줄로 끝난다: `visibleToViewer(null)`은 `publiclyListed()`와 같고, 좋아요 조인은 `on false`가 되어 `likedByMe`가 항상 false다. `c.userId`는 **가드 뒤에서만** 읽는다 — 그래서 그 변수의 타입이 `string`이고, 공개 표면은 `c.viewerId`(`string | null`)를 읽는다.

바디 상한: 기본 5MB JSON, 카드 임포트 두 경로(`POST /api/plots/import`, `POST /api/plots/:id/characters/import`)는 카드 파일 50MB(`MAX_CARD_IMPORT_BYTES` — 넘으면 라우트가 413 `payload_too_large`)에 멀티파트 여유 1MB를 더한 바디, `POST /api/chats/:id/attachments`는 이미지 업로드 상한. RisuRealm의 PNG 카드는 그림을 품어 30MB 안팎이고 charx는 더 크다. **웹의 `/api` rewrite 프록시에도 따로 상한이 있다** — Next 16의 `experimental.proxyClientMaxBodySize`(기본 10MB)이고, 넘으면 413으로 거절하지 않고 서버 로그에 경고만 남긴 채 **바디를 그 크기에서 잘라 넘긴다** — 큰 임포트는 온전히 도착하지 못하고 실패한다. 그래서 `next.config.ts`가 API의 임포트 바디 상한과 같은 51MB로 맞춘다 — 더 큰 바디는 API가 `Content-Length`를 보고 413으로 답한다. 프록시의 `proxyTimeout`(30초)은 총 소요가 아니라 소켓 유휴 시간이라 느린 업로드도 끊지 않는다. 임포트 폼은 이 상한을 넘는 파일을 올리기 전에 거절한다(`card_too_large`).

에러는 항상 `{error: string(개발용 영어), code: string(기계판독)}` + 상태코드. 클라이언트는 code로 번역 메시지를 고른다. 소유권 검사는 필수이며 **타 유저 리소스는 404**다(403이 아니라). uuid 파라미터가 깨졌으면 400이 아니라 404다.

산문이 필요한 계약만 여기 남긴다:

**SSE 생성** — `POST /api/chats/:id/{messages,regenerate,continue,auto,narrate}` 다섯뿐이다. 이벤트 형식과 실패 규약은 §7.2. 그 외 어떤 라우트도 SSE가 아니다. 다섯 모두 선택 필드 `focusCharacterIds: string[]`(다음 화자, §7.2)를 받는다 — `messages` 외의 넷은 바디가 없어도 되고, 오면 JSON 객체여야 한다. id는 플롯의 멤버이면서 **장면에 있는**(빠지지 않은) 멤버여야 하고 아니면 400 `invalid_request`다. 전송은 이 검사를 유저 턴을 쓰기 전에 하므로 거절된 전송은 아무것도 남기지 않는다.

**장면 구성** — `PATCH /api/chats/:id {absentCharacterIds: string[] | null}`. 모든 id가 챗 플롯의 멤버여야 하고(플롯의 공개 여부와 무관하게 로스터로 판정 — 독자 자신의 설정이다) 아니면 400 `invalid_request`, 중복은 하나로 접고, 빈 배열과 `null`은 컬럼을 `null`로 둔다. 다른 챗 설정과 같은 핸들러라 생성 중이면 409다. 챗 JSON은 `absentCharacterIds`를 **언제나 배열로** 싣는다(null이면 `[]`) — 삭제된 멤버의 id가 남아 있을 수 있으므로 클라이언트는 다시 보낼 때 현재 로스터에 없는 id를 걸러 낸다.

**프롬프트 인스펙터** — `GET /api/chats/:id/inspect`는 그 챗에서 **지금 재생성하면** 보낼 프롬프트를 `PromptReport`(§6)로 돌려준다. 재생성의 계획 빌더(`regeneratePlan`)를 그대로 쓰고 `inspectGeneration`으로 조립만 한다 — 슬롯을 잡지 않고, 모델을 부르지 않고, 아무것도 쓰지 않는다. 호출자가 **챗의 소유자이자 플롯의 소유자일 때만** 200이고, 그 밖에는 404다: 남의 플롯에서 연 내 챗은 작가의 글을, 내 플롯에서 남이 연 챗은 남의 대화를 보여 주게 되기 때문이다. 챗 상태 응답의 `isPlotOwner`(boolean)가 웹이 이 기능을 그릴지를 정한다.

**스타일과 두 파생 기능** — `POST /api/plots`와 `PATCH /api/plots/:id`가 `style`을 받는다(객체 또는 `null`, 그 외 타입이면 400 `invalid_request`). 내용은 `coercePlotStyle`을 지나므로 모르는 열거값은 거부가 아니라 **삭제**되고, 남는 것이 없으면 컬럼은 `null`이 된다 — 내레이터와 같은 규약이다. 소유자 뷰는 `style`을 그대로 내고, 공개 뷰도 낸다(위). `PATCH /api/chats/:id`는 독자 몫의 `statusWindowEnabled`/`choicesEnabled`(boolean)를 받고 챗 상태에 그대로 실어 돌려준다 — 다른 챗 설정과 같은 핸들러이므로 **생성 중이면 409 `generation_in_progress`**다(위 §7.2의 슬롯 규약).

**추론 강도** — `PATCH /api/chats/:id {reasoningEffort: string | null}`. 문자열은 챗 모델(같은 바디가 `model`도 바꾸면 **새 모델**)이 광고하는 목록에 있어야 하고, 아니면(광고가 없는 모델 포함) 400 `invalid_request`다. `null`은 지운다(모델 기본값). `model`만 바꾸면 저장된 값은 새 모델도 광고할 때만 남고 아니면 `null`이 된다. 챗 JSON은 `reasoningEffort`를 싣는다.

**추천 프로필** — `POST /api/plots`·`PATCH /api/plots/:id`가 `profiles`를 받는다(배열 또는 `null`, 그 외 타입이면 400 `invalid_request`). 내용은 `coercePlotProfiles`를 지나므로 못 쓸 행은 거절이 아니라 삭제이고, 남는 것이 없으면 컬럼은 `null`이 된다 — 스타일·내레이터와 같은 규약이다. 소유자 뷰와 공개 뷰 모두 `profiles`를 **언제나 배열로** 낸다(컬럼이 null이어도 `[]`). `POST /api/chats`는 `personaId`와 `profileId`를 **동시에 받지 않는다**(둘 다 오면 400 `invalid_request`, 플롯에 없는 id면 404). `profileId`가 오면 서버가 그 프로필을 독자의 `personas`로 복사하고 챗은 그 새 행을 가리킨다 — **중복 제거는 하지 않는다**: 행 하나는 싸고, 같은 프로필로 연 두 대화는 독자가 서로 다르게 키워 갈 두 페르소나다.

**임포트 출처와 발행 권리** — 남이 만든 카드(RisuRealm 등)를 가져오는 것은 막지 않는다. 시스템은 카드의 원작자가 누구인지 확인할 수 없으므로, 대신 출처를 기록하고 공개 직전에 소유자의 확인을 받는다.

- 두 임포트 경로는 업로드 바이트의 SHA-256을 서버에서 계산해 새 멤버의 `imported_from`(§5)에 `{fileName, sha256, sourceUrl?, importedAt}`로 남긴다. 멀티파트 선택 필드 `sourceUrl`은 RisuRealm 캐릭터 페이지만 받는다 — `https://realm.risuai.net/character/<id>`, `https://risuai.xyz/?realm=<id>`, 맨 id 셋이고 id는 UUID 꼴이어야 한다(`apps/api/src/realm.ts`). 저장은 언제나 `https://realm.risuai.net/character/<id>` 한 표기다. 알아볼 수 없는 값은 **버리지 않고 400 `invalid_request`**로 거절한다 — 보낸 클라이언트는 그것이 기록됐다고 믿기 때문이다. 빈 값은 없는 것과 같다. 이 검사는 카드를 파싱하기 전에 한다.
- `POST /:id/publish {publish: true}`는 `imported_from`이 null이 아닌 멤버가 하나라도 있으면 바디의 `rightsConfirmed: true`(boolean, 그 밖의 타입은 400)를 요구하고, 없으면 **409 `rights_unconfirmed`**다. 통과하면 `rights_confirmed_at`을 지금으로 찍는다. 임포트한 멤버가 없는 플롯은 예전과 똑같이 발행되고 아무것도 찍지 않는다. 비공개 전환은 묻지 않는다. 재발행도 매번 묻는다.
- 같은 구멍을 반대편에서 막는다: **이미 공개 중인** 플롯으로의 `POST /:id/characters/import`는 그 임포트 자체가 발행이므로 멀티파트 필드 `rightsConfirmed=true`를 요구하고(없으면 같은 409, 멤버·아바타·에셋은 아무것도 남지 않는다) 통과하면 같은 시각을 찍는다. 비공개 플롯으로의 임포트와 새 플롯을 만드는 임포트는 묻지 않는다 — 공개할 때 묻는다.
- 두 판정 모두 플롯 행을 `for update`로 잡은 트랜잭션 안에서 읽는다(임포트는 `insertMember`, 발행은 발행 트랜잭션). 같은 락이라 비공개였던 플롯에 멤버가 들어오는 사이에 발행이 지나가 아무도 묻지 않는 경우가 없다.
- 소유자 응답(소유자 뷰·로스터·멤버 응답)은 멤버마다 `importedFrom`과 `license`(`cardLicense`, 없으면 null)를, 플롯에 `rightsConfirmedAt`을 싣는다. 제작자는 카드의 `creator` 그대로다. 공개 뷰·탐색·챗 내보내기에는 셋 다 실을 필드가 없다.
- 라이선스는 **보여 줄 뿐 막지 않는다**. 스튜디오는 변경금지(ND)·`private` 라이선스 카드에 더 강한 경고를 걸지만, 소유자가 원작자의 허락을 받았을 수 있고 그것은 시스템이 볼 수 없으므로 하드 블록은 없다.

**해금형 일러스트** — `PATCH /api/plots/:id/assets/:slug`가 `unlock`(객체 또는 `null`)만 받는다. 바이트를 다시 올리지 않고 조건만 고치는 유일한 경로라 업로드 multipart의 필드가 아니라 별도 PATCH이고, 같은 슬러그를 다시 업로드해도 조건을 다시 쓸 필요가 없다. 조건 자체는 **소유자 응답에만** 실린다(`GET /:id/assets`가 소유자에게만 `unlock`을 붙인다) — 키워드는 그 공개가 가질 가치의 스포일러이기 때문이다. 독자가 받는 것은 챗 상태의 `assetLocks: [{assetId, slug, locked, kind}]`뿐이고, `kind`는 힌트이지 조건이 아니다. 소유자 자신의 챗에서는 전부 `locked: false`다.

**팔로우·알림** — `POST`/`DELETE /api/creators/:id/follow`는 멱등이고(쌍이 키다) 둘 다 지금 성립하는 상태(`{followerCount, followedByMe}`)로 답한다. 자기 자신은 400 `invalid_request`. 같은 상태가 `GET /api/creators/:id`에도, 공개 플롯 상세의 `creatorFollow`에도 실려 나간다 — 플롯 페이지의 버튼이 두 숫자를 위해 크리에이터 목록 전체를 읽지 않게 하려는 것이다. `GET /api/notifications`는 첫 페이지에만 `unreadCount`를 얹는다(뱃지는 목록을 열 때 읽는 값이고, 뒷 페이지의 그것은 아무도 묻지 않은 답이다). `POST /api/notifications/read`는 안 읽은 것 전부에 `read_at`을 찍고 `{unreadCount: 0}`으로 답한다.

**발행 팬아웃** — `POST /api/plots/:id/publish`는 `published_at`이 **처음** 찍히는 순간에만 팔로워에게 알린다. 그 판정은 check-then-write라 트랜잭션 안에서 플롯 행을 `for update`로 잡은 채 한다 — 두 번의 클릭이 겹치면 둘 다 안 찍힌 행을 읽고 두 번 알릴 수 있다. 비공개 전환은 `published_at`을 지우지 않으므로 재발행은 아무것도 만들지 않는다. **adult 플롯은 알리지 않는다**: API가 adult를 더는 받지 않지만 그 전에 저장된 행은 연령 인증이 없어 이름만 공개인 상태이므로(`publiclyListed`), 알림을 보내면 열 수 없는 링크를 팔로워 전원에게 쥐여 주는 셈이다. 늦게 알리는 대신 알리지 않는 쪽을 택했다. 알림 행 자체는 이 트랜잭션이 쓰지 않는다 — 누구에게 알릴지는 발행이 정하고, 알리는 일은 큐가 한다(`jobs`, §5). enqueue가 같은 트랜잭션 안이므로 공개되지 못한 플롯의 팬아웃은 남지 않는다. 누가 받는지는 예전 그대로 **발행 시점에 크리에이터를 팔로우하고 있던 전원**이고 상한은 없다 — 자기 자신은 팔로우 라우트가 400으로 막으므로 크리에이터가 자기 발행 알림을 받는 일도 그대로 없다.

**주간 인기** — `GET /api/explore?sort=weekly`는 최근 7일 `plot_likes` 수로 줄을 세우고 동점은 누적 좋아요 → id로 끊는다(모두가 한 번씩 좋아한 작품이 아무도 좋아하지 않은 작품보다는 위다). 창은 상관 서브쿼리로 매 읽기마다 계산한다 — 창 카운터는 시간이 지나는 것만으로 줄어야 하는데 그것을 해 줄 배경 잡이 없기 때문이다. 새 테이블도 새 컬럼도 없고, 카운터 정렬과 같은 스냅숏 커서로 걷는다(아래).

**커서** — 모든 목록이 불투명 `base64url(JSON)` 커서를 쓰고, 깨진 커서는 400 `invalid_request`(500이 아니라). 정렬키가 움직이지 않는 목록은 키셋으로 걷는다: `(정렬키, id)` 튜플 비교, `limit+1`을 한 번 더 뽑아 `nextCursor` 유무를 판정, 없으면 `null`. 카운터 정렬은 그럴 수 없어서 스냅숏으로 걷는다(아래).

| 엔드포인트 | 커서 | 정렬키 | limit 기본/최대 |
|---|---|---|---|
| `GET /api/explore` | `recent`→`{value, id}` 키셋 / `chats`·`likes`·`weekly`→`{seen}` 시드 후 `{session, offset}` 스냅숏 | `published_at` / `chat_count` / `like_count` / 최근 7일 좋아요 수 | 24 / 48 |
| `GET /api/plots/:id/comments` | `{createdAt, id}` 키셋 | `created_at desc, id desc` 고정 | 20 / 50 |
| `GET /api/notifications` | `{createdAt, id}` 키셋 | `created_at desc, id desc` 고정 | 20 / 50 |

시각 커서는 경계 행의 타임스탬프를 id로 DB에서 다시 읽어 마이크로초까지 맞춘다(직렬화가 밀리초라 같은 ms 안의 행을 건너뛸 수 있다).

**카운터 정렬은 스냅숏으로 걷는다** (`apps/api/src/feedCursor.ts`, 두 피드가 공유). 키셋으로는 불가능하다 — 경계는 한 행을 가리키는데 정작 움직이는 것은 *다른* 행들이라, 좋아요가 늘어난 행은 경계를 위로 넘어가 영영 안 나오고 줄어든 행은 아래로 넘어와 두 번 나온다. 커서에 카운트 값을 박아 둬도 그 값은 경계를 설명할 뿐이라 마찬가지다. 그래서 순회가 이미 내준 것을 기억한다.

1페이지는 순회가 아니다. 라이브 쿼리로 그냥 뽑고 **아무것도 쓰지 않으며**, `nextCursor`에 그 페이지의 id들을 그대로 실어 보낸다(시드 커서 `{seen}`). 독자가 실제로 2페이지를 달라고 할 때에야 `feed_cursors` 행이 그 id들로 생긴다 — 대부분의 독자는 페이지를 넘기지 않고, 그런 독자는 예전과 똑같은 비용만 낸다. 그 뒤부터 커서는 `{session, offset}`이고, 이미 낸 오프셋이면 `seen`에서 그대로 재생하고(같은 커서를 두 번 부른 클라이언트가 페이지를 건너뛰지 않는다) 아니면 `seen`에 없는 상위 행들을 새로 뽑아 이어 붙인다. 결과적으로 각 행은 정확히 한 번만, 빠짐없이 나온다.

`seen` 읽기·페이지 선택·`seen` 이어붙이기·다음 커서 결정은 **한 트랜잭션 안에서 커서 행 `for update` 아래** 일어난다. 안 그러면 같은 오프셋을 소비하는 두 요청이 같은 `seen`으로 각자 선택하고 — 그 사이 카운터가 움직였다면 서로 다른 행을 골라 — 각자 자기 개수만큼 오프셋을 밀어, 어느 쪽 순서에도 맞지 않는 위치가 남는다. 락은 순회 하나에만 걸리므로 한 독자를 자기 자신하고만 직렬화한다.

값: 이 정렬들에는 키셋 seek가 없다. 인덱스를 순서대로 읽되 이미 내준 행을 건너뛰며 지나가므로 N번째 페이지가 O(N × limit)행을 스캔한다 — 실제로 독자가 넘기는 몇 페이지 규모에서는 문제가 없고, 갑자기 무너지는 대신 완만하게 나빠진다. 시드 커서는 한 페이지분 id를 싣느라 기본 limit에서 1KB 남짓, 최대에서 2.5KB쯤 된다(순회 깊이가 아니라 limit에 묶인다). 시드 커서를 두 번 소비하면 순회가 둘 생기는데 각각은 일관되고 버려진 쪽은 만료된다 — 모두의 1페이지가 똑같이 생겼으니 내용으로 순회를 공유시킬 수는 없다. `seen`은 `not in (...)`으로 되돌아가므로 순회 깊이는 Postgres 파라미터 한계에 묶인다. 버려진 순회는 순회를 열 때 한 번에 50개까지만 수거하고, 그 뒤에 온 커서는 조용히 처음으로 되돌리지 않고 400을 낸다. `recent`는 그대로 키셋 seek를 유지한다.

**허브 공개 뷰** — 누구에게나 같은 답을 내는 별도의 라우트다. `GET /api/plots/:id/public`(`routes/plots.ts`)이 내는 필드 전부:

- `public: true`(소유자 응답과 형태가 다르다는 표식), id, 이름, 커버, `creatorId`/`creatorName`, `creatorFollow`(`{followerCount, followedByMe}` — 이름 옆의 팔로우 버튼이 읽는 값), 언어, 태그, `likeCount`/`chatCount`, `intro`(플롯의 유저 노출용 소개), `publishedAt`, `likedByMe`
- `characters: [{id, name, avatarUrl, intro}]` — 로스터. `intro`는 **카드의 독자용 소개 하나뿐**이고, 카드 내부(설명·성격·예시 대화·로어북)를 실어 나를 필드는 없다
- `intros`: 도입부 **전문** 배열 + `introPreviews`: 각 200자 컷
- `commentsEnabled`, `commentCount`
- `style` **전부**와 `narrator`의 **`pov`만**(`{pov}` 또는 null) — 배지의 재료다(§11). 둘 다 열거값이라 나가고, 내레이터의 `voice`는 크리에이터가 쓴 프롬프트 텍스트라 소유자 응답에만 남는다. 챗 화면은 이 `style`을 읽어 자기 독자 토글을 둘지 정한다
- `profiles` — 작품이 권하는 독자 프로필 전부. 이름과 소개는 **설계상 독자를 향한 글**이라 여기 실린다(Zeta도 그렇게 보여 준다). 프롬프트 텍스트가 아니다 — 고른 프로필의 복사본이 프롬프트에 가고, 그것은 그때부터 독자의 페르소나다
- 커스텀 UI가 동작하는 데 필요한 것: `displayScripts`, **`defaultVariables`**, `componentCode`, `componentCapabilities`

`intros`는 매크로만 제거하고 자르지 않는다(`hub.ts`의 `publicIntro`). 상세 읽기에만 실리고, 목록(`/api/explore`, `/api/creators/:id`)은 **첫 도입부를 200자로 자른 `introPreview` 하나**만 쓴다: 프롤로그는 독자가 그 작품을 고를지 정하는 글이라 상세에서는 온전히 보여야 하고, 카드 그리드에서는 그럴 자리가 없다. 목록 카드는 그 밖에 `characters`(얼굴 스택용 `{id, name, avatarUrl}`)를 함께 받는다.

`defaultVariables`가 여기 있다는 점을 놓치면 안 된다 — 공개 커스텀 UI가 이 값에 의존하므로 플롯 기본 변수는 **공개 플롯의 공개 데이터**다. 노출 검토는 이 목록 기준으로 해야 한다. 이 네 필드는 상세 읽기에만 실리고 목록에는 없다(목록은 카드 그리드라 변환할 메시지가 없다).

세계관 설정(`description`)·등장인물 카드의 description·personality·로어북·시스템 프롬프트·예시 대화는 소유자에게만 간다. **이것은 API 표면의 기밀성이지 대화의 기밀성이 아니다** — 정확히 어디까지 참인지 구분해서 읽어야 한다.

- 구조적으로 참인 것: 공개 응답에는 세계관 설정과 카드 내부를 **실어 나를 필드 자체가 없다**. 위 목록이 그 응답의 전부이고, 목록·챗 내보내기도 마찬가지다. 그래서 API를 아무리 두드려도 정의는 나오지 않는다.
- 참이 아닌 것: `assemblePrompt`가 만든 **조립된 프롬프트**는 모델 프로바이더에게 간다. 정의 전체가
  아니라 프롬프트에 쓰이는 것들 — 플롯 description·등장인물 description/personality·**활성화된**
  로어·시스템 프롬프트·예시 대화 — 만 실리고, 미활성 로어·카드 `scenario`·`creatorNotes`·
  `displayScripts`·`componentCode`·`extensions`·`raw`는 어댑터에 닿지 않는다. 프로바이더의 출력은
  SSE로 곧장 독자에게 흐른다. 따라서 **프롬프트에 실린 범위 안에서** 정의는 ① 프로바이더에게 보이고
  ② 독자가 모델을 유도해 되뇌게 만들 수 있다.

즉 실제 노출 경로는 API가 아니라 **프로바이더**와 **프롬프트 유도 발설**이다. 후자에 대한 방어는 프리셋의 인캐릭터 유지 지시뿐이고, 그것은 완화이지 보증이 아니다. 작품 정의를 진짜 비밀로 취급해야 하는 상황이라면 이 구조는 그것을 제공하지 않는다.
- 공개 노출 조건은 `visibility='public' AND safety_level='all'`(`hub.ts`의 `publiclyListed`). 연령 인증이 없으므로 생성·수정·발행은 `safetyLevel: 'adult'`를 400 `invalid_request`로 거절하고(스튜디오도 전체 이용가만 내놓는다), 그 전에 저장된 **adult 행은 탐색·공개 상세·타인 챗 시작에서 전면 차단**되고 소유자만 접근한다. 읽기 권한은 `visibleToViewer(viewerId)` 한 줄이 정한다 — 내 것이거나 공개 노출 중이거나. 등장인물·에셋·아바타·댓글은 자기 축이 없으므로 전부 이 한 판정을 통과한 뒤에 나온다.
- 발행 게이트: `name`·`description`·`intros` 중 하나라도 비어 있으면 400 `not_publishable`. **저장된** 행을 읽어 판정하므로 편집 중인 값이 아니라 커밋된 값이 기준이다. 그다음 임포트한 멤버가 있으면 권리 확인이 없을 때 409 `rights_unconfirmed`(위 임포트 출처와 발행 권리).
- 타 유저의 public 플롯으로 챗을 시작하면 원작자의 `plots`/`characters` 행을 직접 참조한다(Zeta/C.AI 방식) — 크리에이터가 수정하면 기존 챗에도 반영된다. 이때만 `chat_count`가 오른다(본인 플롯은 미집계).

## 11. 웹 (apps/web)

전 라우트가 로케일 프리픽스 아래에 있다(`localePrefix: 'always'` — `/ko/...`, 프리픽스 없는 경로는 없다). 다크 테마 기본.

| 경로 | 내용 |
|---|---|
| `/{locale}` | 플롯 탐색 피드 — 검색·태그 칩·정렬 탭(최신/주간 인기/인기/좋아요), 플롯 카드(커버·제목·소개 한 줄·태그·로스터 얼굴 스택·챗/좋아요 수) |
| `/{locale}/plots` | 내 플롯 그리드 + 새 플롯 / AI로 초안 만들기 / 카드 임포트(png·json·charx·jpg(charx)) / RisuRealm에서 가져오기 — 제작 영역(플롯/페르소나/노트 서브탭) |
| `/{locale}/plots/:id` | **플롯 스튜디오** — 한 작품의 전부(아래) |
| `/{locale}/p/:id` | 플롯 공개 페이지 — 커버·소개·태그·스타일 배지·등장인물 스트립·도입부 피커와 전문·좋아요·댓글·대화 시작 패널 |
| `/{locale}/chats/:id` | 챗 화면 |
| `/{locale}/explore` | `/{locale}`로 리다이렉트(구 탐색 경로 보존) |
| `/{locale}/creators/:id` | 크리에이터 공개 플롯 그리드 |
| `/{locale}/personas`, `/notes` | 페르소나 CRUD / 재사용 노트 |
| `/{locale}/login`, `/signup` | 인증 |

`/characters*`·`/c/:id`·`/u/:id`는 **없다**. 리다이렉트도 두지 않았다 — 캐릭터 단위의 공개 주소가 가리킬 대상 자체가 사라졌기 때문이다.

- **플롯 스튜디오**(`/{locale}/plots/:id`)의 섹션: 프로필(제목·소개·커버·태그·콘텐츠 언어·댓글 허용) · 세계관(모델용 설정) · **스타일**(아래) · 등장인물(카드 리스트 — 추가/카드로 추가/RisuRealm에서 추가/삭제/순서 이동, 최대 10, 각각 이름·아바타·독자 소개·설정·성격·예시 대화, 가져온 카드면 출처·제작자·라이선스, 그리고 JSON·PNG **카드 내보내기** 링크 — 저장된 카드를 내보내는 라우트라 링크다) · 도입부(최대 10, 발화 규약 힌트가 붙은 textarea) · **추천 프로필**(최대 5, 이름·소개 — 둘 다 유저 공개 배지) · 로어북(월드 인포 **가져오기**는 파일의 엔트리를 편집 중인 로어북 뒤에 붙여 저장 버튼으로 커밋하고, **내보내기**는 지금 편집 중인 엔트리를 ST 월드 인포 JSON으로 내려받는다 — 둘 다 브라우저에서 `./world-info`로) · 에셋(타일마다 해금 조건 편집기) · 커스텀 UI(표시 스크립트·기본 변수·컴포넌트 코드 + 프리뷰) · 공개 설정(세이프티·발행 토글·가져온 멤버의 권리 확인) · 이 플롯과의 대화 목록.
  - **스타일 섹션**(`PlotStyleEditor`)은 네 묶음이다: 문체(내레이터 문체·시점 · 시제 · 응답 길이 · 표현 방식) · 전개(속도 · 난이도) · 장르·연출(분위기 칩 최대 2 · 스토리텔링 8종) · 부가 기능(상태창 체크박스 · 선택지 3단). 옵션마다 **고른 것 하나의** 한 줄 가이드가 밑에 붙는다(여덟 줄을 늘어놓으면 고르는 화면이 읽는 화면이 된다). 분위기의 상한은 거절이 아니라 **자리를 비우는 방식**이다 — 세 번째를 고르면 가장 먼저 고른 것이 풀린다. 내레이터가 세계관이 아니라 여기 있는 이유는 문체와 시점도 "어떻게 쓸지"이기 때문이고, 저장은 플롯의 다른 필드와 같은 저장 버튼 하나다.
  - 저장 버튼 하나가 플롯 필드와 로스터의 카드를 **함께** 커밋한다(멤버 PATCH들 먼저, 그다음 플롯 PATCH, 응답을 에디터 상태로 채택). 반면 사진 업로드·로스터의 추가/삭제/순서·발행 토글은 **자기 요청이 곧 결과인 것들**이라 각각 즉시 서버에 간다 — 크리에이터가 결과를 봐야 하는 동작이고, 옆에서 쓰던 카드를 서버 사본으로 덮어쓰지 않는다.
- `(app)` 레이아웃은 세션과 무관하게 헤더·본문·모바일 탭바를 렌더한다(공개: `/`, `/p/:id`, `/creators/:id`, `/explore`). 세션 필수 페이지는 하위 `(app)/(member)` 그룹이고, 그 레이아웃이 없으면 `/login?next=<경로>`로 보낸다. `(auth)` 레이아웃은 로케일 스위처만 단다.
- 챗 화면 구성: 메시지 목록(마크다운 + `*지문*`, raw HTML 비활성), 스트리밍 렌더(fetch + ReadableStream SSE 파싱 — 요청이 열린 뒤 첫 글자가 보이기 전까지 생성 중인 말풍선은 "생각 중… N초"를 초 단위로 센다. 추론 내용은 요청하지도 보여 주지도 않는다), 마지막 assistant에 스와이프 ◀ n/N ▶ · 재생성 · 이어쓰기 · 이어가기(auto) · 나레이션, hover 수정, 상단에 플롯으로 돌아가는 링크와 모델·추론 강도(모델이 광고할 때만 — "기본"은 `null`, 아는 단어만 번역하고 나머지는 그대로)·프리셋·페르소나 셀렉트, `ChatPanel`(등장인물 목록과 멤버별 장면에서 빼기/돌아오기·유저노트·첨부 노트·기억 요약과 설정·내레이터 오버라이드·**플롯 기능 토글**·관계 게이지·커스텀 UI 토글·컴포넌트 턴 동의·작가 전용 프롬프트 보기).
- **다음 화자 픽커**(`FocusPicker`): 장면에 있는 멤버가 둘 이상일 때만 작성 모드 칩 줄에 선다. 고른 멤버는 다음 전송·재생성·이어가기(auto) 하나에 `focusCharacterIds`로 실리고, 그 응답이 `done`으로 끝나면 비워진다 — 실패한 응답은 고른 것을 남겨 두어 다시 시도가 같은 것을 다시 요청한다. 이어쓰기·나레이션에는 실리지 않는다(고를 화자가 없다). 장면에서 빠진 멤버는 목록에도 요청에도 없다.
- **프롬프트 보기**(`PromptInspector`, `prompt-inspector`): 챗 상태의 `isPlotOwner`가 참일 때만 패널 맨 아래에 선다. 열 때(그리고 새로고침할 때)만 `GET /:id/inspect`를 읽는다 — 디버깅 도구이고 매번 프롬프트 전체를 조립하는 비용이 든다. 예산 막대(왼쪽부터 사용량, 오른쪽 끝에 응답 몫), 히스토리·예시 대화 포함 개수, 블록 목록(종류·토큰·펼치면 원문, 이어진 히스토리 턴은 한 줄로 접힌다), 발동한 로어(출처·위치·경위·키)를 보여 준다.
- **발화 렌더**: 어시스턴트 메시지는 `parseAssistantSpeech(content, roster)`(§6)로 잘려 한 메시지 안에서 화자가 갈린다. 내레이터 구간은 아바타도 이름도 없이 전폭·기울임으로 "대사 바깥"에 서고(`data-testid="speech-narration"`), 등장인물 구간은 로스터에서 찾은 아바타와 이름을 머리에 달고 그 아래 대사가 온다(`data-testid="speech-character"` + `data-speaker`). 인물 줄 안의 `*…*`는 마크다운 강조로 되돌려 넣어 그 인물의 블록 안에서 상황묘사로 그려진다 — `안녕 *웃으며* 반가워`는 한 문장이지 세 덩어리가 아니기 때문이다. 로스터가 비었거나(플롯 읽기 전, 등장인물이 없는 작품) 유저 턴이면 예전처럼 한 덩어리로 그린다.
- **스타일 배지**(`/p/:id`, `PlotStyleBadges`): 태그 줄 아래에 분위기 → 난이도 → 전개 속도 → 시점 순으로, **기본값이 아닌 것만** 조용한 칩으로 선다(`보통 난이도` 칩은 읽고 나서야 읽을 것이 없었음을 아는 칩이다). 태그가 "무엇에 관한 이야기인지"라면 이쪽은 "어떻게 쓰인 이야기인지"다. 열거값만 나가므로 지시문 텍스트는 여기 실리지 않는다.
- **상태창·선택지 렌더**(`MessageRow`): 메시지 하나에서 `extractChoices` → `extractStatusBlock` → 기존 파이프라인(`MessageBody`) 순으로 읽는다. 순서가 규약이다(§6) — 선택지를 먼저 떼야 상태창 펜스가 턴의 끝이 된다.
  - **상태창 카드**는 메시지 끝에 접히는 카드로 붙고(`키`/`값` 행, 디밍), 접힘 상태는 **챗 단위로 localStorage**에 남는다(`lib/statusCard.ts`) — 매 턴 같은 몇 줄이라 한 번 접은 독자는 그 대화에 대해 말한 것이다. 스트리밍 중 아직 닫히지 않은 펜스는 파서가 이미 텍스트로 남겨 두므로 카드가 깜빡이지 않고, 상태창을 쓴 도입부도 같은 카드로 그려진다.
  - **선택지 버튼**은 **마지막 어시스턴트 메시지에만**, 생성 중이 아닐 때만 그려진다(옛 턴의 줄은 이미 지나간 제안이라 본문에서 떨어져 나간 채 버튼도 없다). 누르면 컴포저를 채우고 **보내지는 않는다** — 표시 스크립트의 버튼과 같은 의미론이다. 독자가 챗 패널에서 선택지를 끄면 버튼 자체가 제안되지 않는다.
  - **플롯 기능 토글**은 플롯이 그 기능을 켠 대화에서만 패널에 나온다(`chat-plot-features`). 없는 기능의 스위치는 반대쪽에 아무것도 없는 스위치라서다. 끄기는 앞으로의 생성에만 걸리고 이미 붙은 상태창은 그대로 남는다.
- **추천 프로필 픽커**(`/p/:id`의 대화 시작 패널): 작품이 권하는 프로필이 칩으로 먼저 서고 독자의 저장된 페르소나 select가 그 아래 온다. 하나를 고르면 select는 **disabled**가 된다 — 배타성은 서버의 규칙이고, 고를 수는 있지만 절대 전송되지 않는 select는 이 챗이 무엇으로 시작하는지에 대한 거짓말이다. 칩을 다시 누르면 풀린다.
- **잠긴 일러스트**는 `{{img::slug}}`가 URL 대신 **마커로 해석되는** 방식으로 그려진다. 메시지 본문이 쓰는 에셋 맵에서 잠긴 슬러그의 값은 `#shizue-lock:<kind>`이고(`lib/assets.ts`), `MessageBody`의 `img`가 그것을 읽어 `LockedImage` 카드를 대신 그린다. 마크다운에는 속성이 없어 데이터를 얹을 곳이 src뿐이고, 프래그먼트는 서버로 가지 않으므로 **없는 그림을 향한 요청이 아예 생기지 않는다** — 측정값을 싣는 `#shizue=` 프래그먼트와 같은 장치다. 표시 스크립트·컴포넌트가 받는 맵에는 잠긴 슬러그가 **아예 없다**(모르는 슬러그와 같은 대접). 카드가 말하는 것은 `kind` 하나뿐이다 — 대화로/진행으로/관계로 해금.
- **일러스트 갤러리**(`ChatPanel`, `chat-illustrations`): 열린 것은 라이트박스로 열리는 썸네일, 잠긴 것은 같은 힌트를 단 실루엣. **해금이 걸린 그림이 하나도 없는 작품에는 섹션 자체가 없다** — 그런 작품에서 이 목록은 보상이 아니라 메시지 목록을 다시 그린 것이다. `done`의 `unlockedAssetIds`가 오면 상태 재조회를 기다리지 않고 그 자리에서 뒤집는다.
- **팔로우 버튼**은 크리에이터 페이지와 플롯 페이지 양쪽에 서고, 좋아요와 같은 낙관적 갱신을 한다(실패하면 버튼이 있던 자리로 돌아가는 것이 답이다). 자기 자신에게는 버튼 대신 팔로워 수만 선다 — API가 400으로 거절할 요청을 그릴 이유가 없다. 카운트는 버튼 이름의 일부다(WCAG 2.5.3 label in name).
- **알림 벨**은 마운트할 때와 창이 다시 포커스될 때 읽는다. 폴링하지 않는다 — 알림 하나는 폴링을 살 만큼 급하지 않고, 탭으로 돌아오는 순간이 정확히 그것이 궁금해지는 때다. 뱃지는 첫 페이지의 `unreadCount`이고, 패널의 "모두 읽음"이 유일한 읽음 조작이다.
- **답장 추천 칩**은 작성 모드 칩 옆의 ✦ 버튼이 불러온다. 누르면 컴포저를 채우고 **보내지는 않는다** — 표시 스크립트의 버튼과 같은 의미론이다. 생성 중에는 버튼이 비활성이고, 턴을 보내거나 재생성하면 칩은 사라진다(지나간 턴에 대한 답이라서). 크리에이터의 **선택지**와는 다른 것이다: 그쪽은 인물이 답 안에서 내미는 제안이고, 이쪽은 독자가 자기 차례에 스스로 부르는 것이다.
- **RisuRealm 가져오기**(`lib/realm.ts`, `components/CardImport.tsx`): 내 플롯 페이지와 스튜디오 등장인물 섹션에서 캐릭터 페이지 주소를 받는다. RisuRealm의 API는 문서상 클라이언트 측 CORS 사용만 허용하고(서버 사용·비문서 엔드포인트 금지) 그래서 **다운로드는 독자의 브라우저가 한다** — 서버는 Realm에 요청하지 않는다. 쓰는 것은 문서화된 `GET https://realm.risuai.net/api/v1/download/:format/:id?cors=true` 하나다: `charx-v3`를 먼저 묻고 403이면 `png-v3`(charx로 올린 카드는 charx-v3만, PNG로 올린 카드는 png·json만 내준다). `non_commercial=true`는 보내지 않는다. 둘 다 403이면 `realm_forbidden`(내려받을 수 없는 카드), 404 `realm_not_found`, 429 `realm_rate_limited`, 그 밖의 실패 `realm_unavailable`, 네트워크·CORS 실패 `realm_unreachable`, 주소가 아니면 `realm_invalid_url`이다 — 상태 0의 `ApiError`라 API 오류와 같은 `errors` 카탈로그로 번역된다. 받은 바이트는 파일 임포트와 같은 경로로 `sourceUrl`과 함께 올라간다. 검색·탐색 UI는 없다(그 엔드포인트들은 문서화되지 않았다) — realm.risuai.net으로 가는 링크만 있다. 앱에는 CSP가 없어 `connect-src`가 막지 않는다(CSP는 컴포넌트 iframe에만 있다, §8.2).
- **권리 확인**: 스튜디오의 공개 설정은 임포트한 멤버가 있으면 발행 버튼 위에 확인 체크박스를 두고, 체크해야 버튼이 열리며 `rightsConfirmed: true`를 보낸다. 판정은 페이지가 들고 있는 로스터로 한다 — 방금 임포트한 멤버는 플롯 읽기보다 먼저 거기 있다. ND·`private` 멤버가 있으면 이름을 들어 더 강한 경고를 붙인다. 공개 중인 플롯에서는 등장인물 섹션이 같은 체크박스를 두고, 체크해야 파일·RisuRealm 임포트가 열리며 임포트마다 다시 묻는다. 가져온 멤버는 카드 머리에 "가져옴" 배지를, 펼치면 출처(Realm 링크 또는 파일 이름)·제작자·라이선스(코드와 CC 조건 풀이, 없으면 "라이선스 표기 없음")를 보여 준다.
- **AI 초안 패널**은 내 플롯 페이지의 `새 플롯` 옆에 있다. 한 줄 설정 → `POST /api/plots/draft` → 돌아온 필드로 평범한 생성 POST → 등장인물을 로스터 엔드포인트로 하나씩 → 편집기로 이동. **초안의 검토 화면은 편집기다** — 마음에 들지 않는 초안은 다투는 다이얼로그가 아니라 지우는 플롯이다.
- **작성 모드 칩** 3종 — 대사(기본) / 묘사(보낼 때 `*…*`로 감싼다) / 내레이터(보낼 때 `@:`를 붙인다). 나가는 텍스트를 표시할 뿐 저장 형식은 손으로 칠 수 있는 그 규약 그대로다.
- `MessageBody`가 렌더 파이프라인의 중심이다: 표시 스크립트 → HTML/텍스트 섬 분리 → 컴포넌트 호출 코드 분리 → **남은 평문만 화자별로 분할** → 텍스트는 `react-markdown`, HTML 섬은 새니타이즈 결과를 `.shizue-msg` 아래에, 호출 코드는 `ComponentFrame`으로. 화자 분할이 마지막인 이유는 앞의 둘이 만든 것은 크리에이터의 마크업이고 컴포넌트라 쪼갤 대상이 아니기 때문이다.
- **AI 고지**(SB 243 / EU AI Act Art.50): 챗 최초 진입 시 1회 배너 + 헤더 상시 "AI" 뱃지. 닫으면 localStorage에 기억한다.
- 예약 장르 태그 12종(로맨스/판타지/BL/GL/HL/일상/공포/미스터리/액션/SF/사극/코미디)은 **클라이언트 상수**다(`lib/hub.ts`). 서버는 모르고, 자유 태그는 그대로 동작한다 — 태그 에디터의 제안 칩과 탐색 필터의 우선 노출에만 쓴다.
- 상태 관리는 클라이언트 fetch 직접(SWR/react-query 없음). 컴포넌트 라이브러리 없이 Tailwind.

### i18n

- **단일 도메인 + 로케일 경로 프리픽스** (`/ko`, `/en`, `/ja`). 국가별 도메인 분리 금지 — 제작자·세계관·독자의 콘텐츠 풀은 전 로케일이 공유한다.
- UI 로케일과 콘텐츠 언어는 별개 축이다. UI는 URL 프리픽스가 결정(`next-intl`, 카탈로그 `apps/web/messages/{ko,en,ja}.json`, ko가 원본). 콘텐츠는 `plots.language`.
- **탐색·피드는 UI 로케일과 콘텐츠 언어가 일치하는 것만 노출한다(하드 파티션)** — `/ja`에서는 일본어 플롯만 보인다. 크리에이터 국적과 무관하다. 예외 둘: ① 내 플롯 목록은 로케일 무관하게 전부, ② 상세·챗 직접 링크는 로케일 무관 허용(공유 링크가 깨지면 안 된다).
- 첫 방문은 `Accept-Language` 감지, 이후 쿠키. UI 문자열 하드코딩 금지 — 전부 카탈로그 경유.
- 응답 언어는 프리셋의 공통 규칙("상대방이 쓴 언어로 답한다")이 정한다. 챗별 고정 옵션은 없다.

## 12. 운영 envelope

- **단일 인스턴스 가정**: 유저별 생성 슬롯(`deps.generating`), 챗별 메모리·관계 guard가 전부 프로세스 로컬이다. (업로드는 더 이상 여기 들어가지 않는다 — `STORAGE_DRIVER=s3` 면 아바타·에셋·커버·첨부 이미지가 공유 스토어에 있다, §9.2.) API를 다중 인스턴스로 띄우기 전에 공유 저장소(Redis/DB 리스)로 옮겨야 한다. ChatGPT 토큰 갱신은 DB 행 락이라 이미 인스턴스 사이에서도 한 번만 일어나고, 모델 카탈로그 캐시(30초)는 인스턴스마다 따로다.
- **응답 길이는 고정 1,200토큰**이다(`DEFAULT_MAX_RESPONSE_TOKENS`). 유저 조절 노출 없음. 발화 프로토콜 턴(다화자+내레이션)에 맞춘 값으로, 단일 캐릭터 시절의 600은 문장 중간 절단을 냈다.
- 결제(PG)·본인인증 연령 게이팅·NSFW 모드는 외부 계약 선행 필요 → 명시적 보류. 그때까지 adult 등급은 꺼 두고(API가 거절한다), `safety_level` 컬럼이 훅으로 남는다.
- **미구현으로 알려진 것**: 탐색 숨김 태그의 서버 저장(현재 localStorage).
- 배경 작업(요약·사실 추출·관계 추출)은 전부 응답 경로 밖이고 자기 실패를 삼킨다. 대화 응답 지연에 영향을 주면 안 된다. 메모리 채널 모델의 키가 없으면 조용히 전부 꺼진다.

### 테스트

- `pnpm test`(루트 vitest)가 전 패키지를 돈다. **`apps/api/test/api.test.ts`는 실제 Postgres를 쓰고 매 테스트마다 전 테이블을 TRUNCATE한다** — 그래서 대상은 스스로 스크래치임을 밝혀야 한다. `resolveTestDatabaseUrl`이 `TEST_DATABASE_URL`을 요구하고(**`DATABASE_URL` 폴백 없음** — CI 시크릿이 담고 있을 값이 그것이다), `DATABASE_URL`과 같으면, `NODE_ENV=production`이면, `database` 쿼리 파라미터가 붙어 있으면, DB 이름이 `_test`로 끝나지 않으면 스위트 자체가 뜨지 않는다. `database` 파라미터를 막는 이유는 postgres.js가 DB 이름을 pathname에서 읽으면서 모르는 쿼리 파라미터는 startup 패킷으로 흘려보내고, 서버가 거기 있는 `database`를 우선하기 때문이다 — `…/plot_test?database=plot`은 URL만 보면 스크래치인데 실제로는 `plot`을 연다(postgres@3.4.9에서 확인). 그래서 마지막 관문은 문자열이 아니라 열린 커넥션이다: `beforeAll`의 `assertDisposableTarget`이 `current_database()`를 물어보고 `_test`가 아니면 첫 TRUNCATE 전에 멈춘다. 이름 검사가 남아 있는 이유는 앱 DB 문자열을 `TEST_DATABASE_URL`에 그대로 복사한 CI를 동등성 검사만으로는 못 잡기 때문이다(`DATABASE_URL`이 함께 export되지 않으면 통과한다). 마커 테이블은 스위트가 마이그레이션으로 스키마를 직접 만드는 이상 스스로 심어야 하므로 없는 것과 같다. 스크래치 DB 생성은 README §검증. 같은 DB에 두 테스트 프로세스가 동시에 붙으면 서로의 데이터를 지워 FK 위반으로 깨진다.
- 스토리지: `storage.test.ts`가 로컬·실제 S3(compose의 RustFS) 드라이버의 왕복, 덮어쓰기, 삭제 멱등성과 네임스페이스 분리를 확인한다. `api.test.ts`는 아바타·에셋 업로드→서빙→삭제를 확인한다. `TEST_S3_REQUIRED=1`은 S3 서버가 없을 때 skip 대신 실패시킨다.
- core: 카드 V1/V2/V3 픽스처 매핑, PNG/charx는 테스트에서 프로그래밍으로 생성해 왕복 검증, 로어북(constant/selective/regex/예산/재귀), 데코레이터, 매크로, 변수, 표시 스크립트, 컴포넌트 서브셋, 프롬프트 조립(탈락 순서·depth 위치·author's note 잔존).
- llm: OAuth·토큰 회전·권한 해제, Responses 종료/오류·SSE 파서, ChatGPT 전용 registry, echo 취소. 테스트 임베더를 사용하는 메모리 정합성은 API 테스트가 확인한다.
- web: RisuRealm 주소 파서·다운로드 폴백·라이선스 판정(`realm.test.ts`), 새니타이저 회귀(XSS 벡터), **새니타이저 호환 게이트**(실제 유통 형태 카드 12종의 출력 고정 — 규칙을 조여 크리에이터 자산을 깨뜨리는 변경을 잡는 반대쪽 절반), 표시 스크립트, **표시 스크립트 플래너**(stub 워커로 종료 경로, Node 워커 스레드로 실제 종료), 컴포넌트 호출 파서·브리지·워커 런타임, SSE 파서, 허브 유틸.
- e2e(`apps/e2e`, Playwright, echo 모델 고정): 스모크(테스트 세션 생성→플롯 생성→등장인물 2명→도입부→발행→공개 페이지에서 챗 시작→도입부 스와이프→발화 구분 렌더→재생성→수정→노트→로케일 전환), 플롯 로스터(발행 게이트·순서 변경·삭제), 카드 임포트(`cardImport.spec.ts` — rewrite 프록시의 기본 10MB를 넘는 카드 파일 → 출처·라이선스 표시 → 권리 확인 후 발행 → Realm 다운로드를 `page.route`로 대신한 RisuRealm 추가), 허브, 댓글, 태그, 세이프티, 내레이터, 커스텀 UI, 비주얼 베이스라인, **P1**(`p1.spec.ts` — 추천 프로필 작성→픽커로 챗 시작·해금 조건 설정→잠긴 카드→키워드 턴→갤러리 반영·팔로우 토글·주간 인기 탭·두 계정 알림 플로우). **AI 초안과 답장 추천은 e2e에 없다** — 둘 다 echo가 대신할 수 없는 실제 모델 호출(초안은 기본 채팅 모델의 엄격 JSON, 추천은 메모리 채널)이라 계약은 `apps/api/test`가 본다. 매 실행이 새 계정을 쓰므로 반복 실행 가능하다. 타입체크는 이 패키지의 자체 tsconfig가 한다(`tsc -p apps/e2e/tsconfig.json` — 스펙의 절반이 브라우저에서 도는 코드라 DOM lib를 함께 켠다).

## 13. 컨벤션

- 코드 식별자·주석 영어. UI 문자열은 i18n 카탈로그(ko/en/ja) 경유 — 하드코딩 금지.
- 에러는 JSON `{error, code}` + 적절한 상태코드.
- 경계를 건너는 페이로드 스키마는 `@shizue/contracts`에서 import한다. 복제 금지.
- 커밋은 리드가 한다 (구현 레인은 커밋 금지).
- 일반 변경은 영향받는 테스트 파일과 타입체크를 실행한다. 의존성 업데이트·여러 계층에 걸친 변경·릴리스는 전체 빌드와 테스트를 실행한다. 인증·보안·데이터 정합성·진행 중 입력 잠금 회귀는 유지하고, 정적 문구·CSS 클래스·단순 래퍼나 다른 계층에서 같은 실패를 잡는 중복 테스트는 추가하지 않는다. 내보내기 스키마를 건드렸다면 계약 빌드·테스트와 API·웹 소비자를 같은 변경에서 검증한다 — 루트 `AGENTS.md`.

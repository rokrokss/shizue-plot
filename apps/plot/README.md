# shizue

플롯과 캐릭터를 만들고 지속적인 대화를 이어가는 캐릭터챗 제품이다.
카드 가져오기, 대화 분기·재생성·편집, 기억과 관계, 페르소나와 노트,
플롯 탐색·팔로우·알림을 제공한다. UI는 한국어·영어·일본어를 지원한다.

## 실행과 검증

설치, 인프라, 개발 서버와 테스트 명령은 리포지터리 루트
[README.md](../../README.md)를 따른다. 설정 예시는 `.env.example`에 있다.
API는 이 디렉터리의 `.env`를 읽는다.

루트에서 `pnpm build`, `pnpm typecheck`, `pnpm test`, `pnpm test:e2e`를 실행한다.
API 테스트에는 운영 DB와 다른 `_test` 데이터베이스가 필요하다.

## 구조

- `apps/api`: Hono API, better-auth 인증, 생성·기억·관계 처리, 이미지 스토리지.
- `apps/web`: Next.js 앱과 next-intl 로케일, 캐릭터·플롯 편집과 챗 화면.
- `apps/e2e`: Playwright 브라우저 테스트.
- `packages/core`: 캐릭터 카드, 프롬프트, 발화와 표시 규약.
- `packages/db`: PostgreSQL + pgvector 스키마와 마이그레이션.
- `packages/llm`: 모델 레지스트리와 OpenAI 호환 어댑터, 개발용 echo 모델.

제품 내부 동작은 [ARCHITECTURE.md](docs/ARCHITECTURE.md), 창작자 안내는
[CREATOR-GUIDE.md](docs/CREATOR-GUIDE.md)를 참조한다.
챗 내보내기 형식은 루트 [PLATFORM.md](../../docs/PLATFORM.md)가 소유한다.

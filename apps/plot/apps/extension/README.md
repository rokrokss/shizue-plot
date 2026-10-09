# shizue 로그인 도우미

Sign in with ChatGPT를 호스팅된 shizue 웹에서 끝내 주는 크롬 확장이다.

OpenAI의 오픈소스 로그인 흐름은 `http://127.0.0.1:<port>/auth/callback`으로만 돌아온다. 이 주소는
서버가 아니라 사용자 기기를 가리키므로 웹 서버는 받을 수 없다. 이 확장은 정적
declarativeNetRequest 규칙 하나로 그 이동을 연결 전에 `<웹 오리진>/api/chatgpt/callback`으로
바꾼다(쿼리 유지). 토큰 교환과 저장은 API 서버가 하고, 확장은 아무것도 읽거나 보관하지 않는다.

- 권한: `declarativeNetRequestWithHostAccess`, 호스트 권한 `http://127.0.0.1/*` 하나.
- `sw.js`는 웹이 설치 여부를 묻는 ping에만 답한다(`externally_connectable`).
- 확장 ID는 매니페스트 `key`로 `naclpiefafceoehanglehokfnibaicle`에 고정된다. 웹은
  `NEXT_PUBLIC_CHATGPT_EXTENSION_ID`로 다른 ID를 받을 수 있다.
- 로그인할 때만 필요하다. 이후 AI 요청은 API 서버가 OpenAI와 직접 통신한다.

## 설치 (개발자 모드)

1. Chrome에서 `chrome://extensions`를 연다.
2. 오른쪽 위 **개발자 모드**를 켠다.
3. **압축해제된 확장 프로그램 로드**로 이 폴더(`apps/plot/apps/extension`)를 고른다.

커밋된 `manifest.json`·`rules.json`은 개발 환경용이다: 루프백 포트 47801 → `http://localhost:13000`.
API의 `CHATGPT_CALLBACK_PORT` 기본값과 같다.

## 다른 오리진용 빌드

```sh
node apps/plot/apps/extension/scripts/variant.mjs --out /tmp/shizue-helper \
  --target http://localhost:13000=47801 --target https://plot.example.com=47811
```

오리진마다 루프백 포트가 하나씩 필요하고, 그 오리진의 API는 같은 포트를
`CHATGPT_CALLBACK_PORT`로 설정해야 한다. 인자 없이 실행하면 이 폴더의 개발용 파일을 다시 쓴다.
`test/variant.test.ts`가 커밋된 파일과 생성 결과가 같은지 확인한다.

## 범위

호스팅된 서비스가 사용자 토큰을 서버에 보관하는 것은 OpenAI의 오픈소스 흐름 범위 밖이며
별도 신청([interest form](https://openai.com/form/sign-in-with-chatgpt-interest/))이 필요하다.
승인 전에는 개발자 본인 계정으로만 테스트한다. 승인 후 파트너 연동 방식이 정해지면 이 확장은
필요 없어질 수 있다.

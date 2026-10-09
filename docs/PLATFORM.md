# shizue — 챗 내보내기 SSOT

캐릭터챗 제품의 내보내기 형식은 `packages/contracts`가 소유한다.
스키마와 타입은 `@shizue/contracts`에서 import하며 소비자가 따로 선언하지 않는다.

## 챗 내보내기

`GET /api/chats/:id/export`는 로그인한 챗 소유자만 호출할 수 있다.
현재 브랜치의 메시지, 공개 플롯 정보, 등장인물 이름·아바타와 공개 이미지,
독자가 첨부한 이미지를 `ChatExportSchema`에 맞게 반환한다.

세계관 설정, 카드 내부 설정, 로어북, 시스템 프롬프트와 아직 해금되지 않은
이미지는 내보내지 않는다. URL은 같은 오리진의 API 경로다. 타임스탬프는
ISO 8601 문자열이며, 상세 필드 정의는 `packages/contracts/src/chatExport.ts`가
단일 원천이다.

## 패키지와 검증

API는 워크스페이스의 `@shizue/contracts`를 `workspace:*`로 참조한다.
`dist/`는 커밋하지 않고 `pnpm install`의 `prepare`와 빌드가 생성한다.
스키마가 바뀌면 계약 테스트, 제품 타입체크와 API 테스트를 함께 검증한다.

0.x 버전에서 필드 제거·이름 변경·타입 변경 등 호환성을 깨는 변경은 minor,
호환되는 스키마 변경은 patch를 올린다. 현재 패키지 버전은 `0.3.0`이다(플롯 이름 변경으로 `storyId`·`storyName`이 `plotId`·`plotName`이 되었다).

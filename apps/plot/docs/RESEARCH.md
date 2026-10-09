# 리서치 요약 — 캐릭터챗 시장·오픈소스·핵심 기술 (2026-08)

shizue 기획의 근거가 된 리서치 종합. 상세 출처는 각 절 참고.

## 시장 구도 (한국)

| | Zeta (스캐터랩) | Crack (뤼튼) | Elyn | Character.AI |
|---|---|---|---|---|
| 포지션 | 무료·대중 (MAU 402만) | 종량·중간 품질 | 프리미엄·파워유저 | 글로벌 최대, 강한 필터 |
| 장기기억 | 제한적 | 약함(최대 불만) | 무제한 (핵심 셀링포인트) | 유료(Chat Memories) |
| NSFW | 불가 | 필터 | 성인인증 후 허용 | 불가 |
| 크리에이터 수익 | 없음 | 조건부 10% | 3→8% + 1오브=1원 환금 | 사실상 없음 |
| 과금 | 무료+광고+패스 | 크래커 종량 | 오브 종량+무제한 패스 | 구독 $9.99 단일 |

Elyn(elyn.ai) 재현 목표 스펙: 페르소나 4,000바이트, 첫 메시지 최대 10개, 로어북 250개(활성 ~8K 토큰 예산), 에셋 이미지 100개, 커스텀 JSX 채팅 UI, 유저노트 100개(2,000바이트), 채팅 분기, 프롬프트 프리셋, 다단계 모델 선택. 이미지 생성·TTS 없음(에셋 이미지 중심).

실패 사례 교훈: 제타 음성·이미지 생성 철수(2026, 비용 대비 효과), 출판사 6곳 저작권 고발. Elyn Stripe 이탈→토스페이먼츠(NSFW·PG 정책). Character.AI 18세 미만 오픈엔드 챗 금지(2025.11).

## 오픈소스 레퍼런스

- **RisuAI** (github.com/kwaroran/RisuAI): Svelte 5+Tauri, 로직 100% 클라이언트. 카드 V3 레퍼런스 구현(`@risuai/ccardlib`). 로어북 데코레이터, supaMemory(요약)/hypaMemory V3(요약+벡터), 트리거 스크립트(Lua/비주얼 블록), CBS 매크로, PromptItem 카드 배열식 프롬프트 템플릿, 용도별 모델 채널 분리(`seperateModels`)+폴백 체인, 모듈(.risum) 패키징.
- **SillyTavern**: World Info(재귀/sticky/probability/그룹 스코어링), 벡터 스토리지+Summarize+Data Bank 3층 메모리, Prompt Manager, STscript.
- **캐릭터 카드 스펙**: V1(플랫 6필드) / V2(`chara_card_v2`: system_prompt, post_history_instructions, alternate_greetings, character_book, extensions 보존 규칙) / V3(`chara_card_v3`: assets, `embeded://`, 데코레이터, use_regex, .charx=ZIP). PNG tEXt `chara`(v1/v2)·`ccv3`(v3) 청크, base64 JSON.

## 핵심 기술 결정 근거

- **비용**: 캐릭터챗은 "동일 프리픽스+턴 추가" 패턴 → Anthropic 프롬프트 캐싱(cache_control, 읽기 0.1×)으로 입력비 ~90% 절감 가능. 무료 티어 초저가 모델(DeepSeek/Flash), 유료 Sonnet급, 보조 호출(요약/추출) Haiku급 라우팅.
- **프롬프트**: 작가 프레이밍("캐릭터에 목소리를 부여하는 작가") > 빙의 프레이밍. 임퍼서네이션 방지 = 시스템+post-history 지시 + `\n{{user}}:` stop sequence + 후처리. post_history_instructions는 모델이 가장 강하게 따르는 위치.
- **메모리 (Phase 2)**: 3층 하이브리드 — 최근 20~40턴 원문(캐시 프리픽스 유지) + 롤링 요약(저가 모델) + 유저×캐릭터 영구 사실(pgvector). 요약 갱신 주기를 길게 잡아 캐시 파손 최소화.
- **인프라**: SSE(LLM API 자체가 SSE, 무상태 확장) + 응답 경로에서 보조 LLM 호출 금지(후처리는 큐로). 메시지는 append-only + parent_id 트리(리롤·분기 필수 요건). 카드는 원본 PNG(S3/디스크)와 정규화 JSON(DB) 이원 저장.
- **규제 (Phase 3)**: 본인인증 연령 게이팅 + 전연령/성인 모드 분리는 국내 필수(제타 국감, C.AI 선례). 입출력 양방향 모더레이션, UGC 카드 사전 심사, NSFW 시 PG 정책 확인.

## 로드맵

- **Phase 1 (현재)**: 계정/인증, 캐릭터 CRUD+임포트(PNG/charx/JSON), 로어북(키워드+constant+예산), SSE 챗(재생성/수정/이어쓰기/스와이프), 유저 페르소나, 메시지 트리, 프롬프트 캐싱, 레이트리밋·토큰 미터링.
- **Phase 2**: 3층 메모리, 채팅 분기 UI, 프롬프트 프리셋 편집기, V3 데코레이터·재귀 스캔, 모델 티어.
- **Phase 3**: 캐릭터 허브(탐색/랭킹), 크리에이터 대시보드·수익 배분, 결제(토스페이먼츠), 연령 게이팅·모더레이션 파이프라인.
- **Phase 4**: 그룹챗, 커스텀 채팅 UI(JSX), 자율 진행, AI 캐릭터 생성 보조, (검증 후) 인레이 이미지·TTS.

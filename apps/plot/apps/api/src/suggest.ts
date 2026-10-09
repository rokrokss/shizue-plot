/**
 * Reply suggestions (see docs/ARCHITECTURE.md §7).
 *
 * Three things the reader could say next, offered beside the composer. They are
 * the reader's own half of the conversation — distinct from the creator's
 * 선택지, which are offers the plot's characters make inside a reply — so they
 * never speak for the characters and never move the scene on their own.
 *
 * The call goes to the memory channel model: it is a cheap, frequent, throwaway
 * request, and a deployment without that key simply does not offer the button.
 * Nothing is stored — a suggestion the reader ignores must leave no trace.
 */
import type { Message } from '@shizue/db';
import type { ChatRequest } from '@shizue/llm';
import type { AppDeps } from './deps.js';
import { ApiError } from './errors.js';
import { collect, memoryChannel } from './memory.js';
import { transcriptLine } from './transcript.js';

/** How much of the branch tail the model reads. */
const RECENT_TURNS = 10;
/** One suggestion is a line the reader could send as it stands, not a paragraph. */
export const MAX_SUGGESTION_LENGTH = 200;
const SUGGESTION_COUNT = 3;
/** Deadline for one call; the reader is waiting on this one, unlike the sidecars. */
const SUGGEST_TIMEOUT_MS = 20_000;
const SUGGEST_MAX_TOKENS = 600;
/** Parse failures tolerated before the button reports back empty-handed. */
const SUGGEST_ATTEMPTS = 2;

const SUGGEST_RULES = `당신은 롤플레이 대화에서 독자가 다음에 보낼 만한 답장을 제안합니다.

규칙:
- 독자 본인의 답장만 씁니다. 등장인물의 대사나 반응을 대신 쓰지 않습니다.
- 서로 다른 방향으로 3개를 제안합니다. 같은 말을 바꿔 쓴 것은 제안이 아닙니다.
- 각 제안은 200자를 넘지 않으며, 그대로 보낼 수 있는 완성된 한 턴이어야 합니다.
- 대사는 그냥 쓰고, 행동이나 상황은 \`*…*\` 안에 씁니다. 두 가지를 섞어 써도 됩니다.
- 마지막 장면에 직접 이어지도록 씁니다. 아직 일어나지 않은 사건을 단정하지 않습니다.
- 대화에서 쓰인 언어와 같은 언어로 씁니다.

출력 형식: 아래 스키마를 따르는 JSON 객체 하나만 출력합니다. 코드 블록이나 다른 텍스트를 덧붙이지 않습니다.
{
  "suggestions": [string, string, string]
}`;

export interface SuggestInput {
  /** The reader asking, whose ChatGPT account writes the suggestions. */
  userId: string;
  /** The branch tail, oldest first; the caller has already windowed it. */
  recent: Message[];
  plotName: string;
  /** The persona's name, or the default one when this chat has no persona. */
  userName: string;
  personaText: string;
}

/**
 * Calls the memory channel model and parses its answer. Throws rather than
 * returning null: unlike the background jobs this one is answering a request, so
 * the reader is told which of the two things went wrong — the deployment has no
 * memory model at all (503), or this call did not come back usable (502).
 */
export async function suggestReplies(deps: AppDeps, input: SuggestInput): Promise<string[]> {
  const resolved = await memoryChannel(deps, input.userId);
  if (!resolved) {
    throw new ApiError(503, 'suggestions_unavailable', 'Reply suggestions are not configured');
  }

  // Image references are markup for the chat, not something to answer.
  const transcript = input.recent
    .slice(-RECENT_TURNS)
    .map((message) => transcriptLine(message, input.userName))
    .join('\n');
  const request: ChatRequest = {
    model: resolved.providerModel,
    system: SUGGEST_RULES,
    messages: [
      {
        role: 'user',
        content: [
          `[작품] ${input.plotName}`,
          `[독자] ${input.userName}`,
          ...(input.personaText.trim() ? [`[독자 설정] ${input.personaText.trim()}`] : []),
          '',
          '[최근 대화]',
          transcript,
        ].join('\n'),
      },
    ],
    maxTokens: SUGGEST_MAX_TOKENS,
    abortSignal: AbortSignal.timeout(SUGGEST_TIMEOUT_MS),
  };

  for (let attempt = 0; attempt < SUGGEST_ATTEMPTS; attempt += 1) {
    try {
      const suggestions = parseSuggestionsJson(await collect(resolved.adapter, request));
      if (suggestions) return suggestions;
    } catch (error) {
      console.error('[suggest] call failed', error);
    }
  }
  throw new ApiError(502, 'suggestions_failed', 'The model did not return usable suggestions');
}

/**
 * The model's answer as chips, or null when it holds none. Over-long lines are
 * cut rather than dropped: the cap is the composer's, and two chips out of three
 * is a worse answer than three whose longest one ends a little early.
 */
function parseSuggestionsJson(raw: string): string[] | null {
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start < 0 || end <= start) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.slice(start, end + 1));
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== 'object') return null;

  const { suggestions } = parsed as { suggestions?: unknown };
  const picked = (Array.isArray(suggestions) ? suggestions : [])
    .filter((suggestion): suggestion is string => typeof suggestion === 'string')
    .map((suggestion) => suggestion.trim().slice(0, MAX_SUGGESTION_LENGTH))
    .filter((suggestion) => suggestion.length > 0)
    .slice(0, SUGGESTION_COUNT);
  return picked.length > 0 ? picked : null;
}

/**
 * Reply suggestions (see docs/ARCHITECTURE.md §7).
 *
 * Three things the reader could say next, offered beside the composer. They are
 * the reader's own half of the conversation — distinct from the creator's
 * 선택지, which are offers the plot's characters make inside a reply — so they
 * never speak for the characters and never move the scene on their own.
 *
 * The call goes to the memory channel model — the chat's auxiliary model: it is
 * a cheap, frequent, throwaway request, and a deployment without that key simply
 * does not offer the button.
 * Nothing is stored — a suggestion the reader ignores must leave no trace.
 */
import type { Character, Message } from '@shizue/db';
import type { ChatRequest } from '@shizue/llm';
import type { AppDeps } from './deps.js';
import { ApiError } from './errors.js';
import { collect, memoryChannel } from './memory.js';
import { transcriptOf } from './transcript.js';

/** How much of the branch tail the model reads. */
export const RECENT_TURNS = 10;
/** One suggestion is a line the reader could send as it stands, not a paragraph. */
export const MAX_SUGGESTION_LENGTH = 200;
const SUGGESTION_COUNT = 3;
/** Deadline for one call; the reader is waiting on this one, unlike the sidecars. */
const SUGGEST_TIMEOUT_MS = 20_000;
const SUGGEST_MAX_TOKENS = 600;
/** Parse failures tolerated before the button reports back empty-handed. */
const SUGGEST_ATTEMPTS = 2;

const SUGGEST_RULES = `You suggest replies the user might send next in a roleplay conversation.

Rules:
- Write only the user's own replies. Do not write the characters' lines or reactions for them.
- Suggest 3 replies that go in different directions. Rewording the same thing is not a new suggestion.
- Each suggestion is no longer than 200 characters and must be one complete turn that can be sent as it is.
- Write dialogue as it is, and actions or situations inside \`*…*\`. Mixing the two is fine.
- Follow directly on from the last scene. Do not assert events that have not happened yet.
- Write in the same language as the conversation.

Output format: output only one JSON object that follows the schema below. Do not add a code block or any other text.
{
  "suggestions": [string, string, string]
}`;

export interface SuggestInput {
  /** The reader asking, whose ChatGPT account writes the suggestions. */
  userId: string;
  /** The chat's auxiliary model, which writes them; null for the default. */
  subModel: string | null;
  /** The branch tail, oldest first; the caller has already windowed it. */
  recent: Message[];
  /** The roster, by whose ids a group reply names its speaker. */
  members: readonly Pick<Character, 'id' | 'name' | 'card'>[];
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
  const resolved = await memoryChannel(deps, input);
  if (!resolved) {
    throw new ApiError(503, 'suggestions_unavailable', 'Reply suggestions are not configured');
  }

  // Image references are markup for the chat, not something to answer.
  const transcript = transcriptOf(input.recent.slice(-RECENT_TURNS), input.userName, input.members);
  const request: ChatRequest = {
    model: resolved.providerModel,
    system: SUGGEST_RULES,
    messages: [
      {
        role: 'user',
        content: [
          `[Story] ${input.plotName}`,
          `[User] ${input.userName}`,
          ...(input.personaText.trim() ? [`[User profile] ${input.personaText.trim()}`] : []),
          '',
          '[Recent conversation]',
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

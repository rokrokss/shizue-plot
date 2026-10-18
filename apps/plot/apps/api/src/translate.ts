/**
 * The translator (ARCHITECTURE §7.8): RisuAI's LLM translator (`translateLLM`),
 * run on the chat's auxiliary model — the reader's own ChatGPT account, the only
 * provider this product has, so no third-party translation API is ever asked.
 *
 * Texts are sent the way RisuAI's super-chunked translation sends them: gathered
 * into requests of under 5,000 characters (`translationBatches`), joined on `■`
 * and split back on it. Where the model's answer does not split into as many
 * texts as were sent, RisuAI translates them one by one; this halves the batch
 * and tries each half, which reaches one by one in the worst case and costs a
 * couple of calls in the usual one.
 */
import {
  splitTranslation,
  translationBatches,
  translationTurns,
  type TranslationLanguage,
} from '@shizue/core';
import type { LLMAdapter } from '@shizue/llm';
import type { AppDeps } from './deps.js';
import { ApiError } from './errors.js';
import { collect, memoryChannel, type AuxiliaryOwner } from './memory.js';

/** One request's deadline. A reader is waiting on the original meanwhile, not on a blank. */
const TRANSLATE_TIMEOUT_MS = 60_000;
/**
 * The answer's ceiling. RisuAI's preset default is 1,000 tokens; a 5,000-character
 * batch can need more than that, and the ChatGPT path sends no ceiling at all.
 */
const TRANSLATE_MAX_TOKENS = 4000;
async function translateBatch(
  adapter: LLMAdapter,
  model: string,
  texts: string[],
  language: TranslationLanguage,
): Promise<string[]> {
  const turns = translationTurns(texts, language);
  const answer = await collect(adapter, {
    model,
    system: turns.system,
    messages: [{ role: 'user', content: turns.user }],
    maxTokens: TRANSLATE_MAX_TOKENS,
    abortSignal: AbortSignal.timeout(TRANSLATE_TIMEOUT_MS),
  });
  const split = splitTranslation(answer, texts.length);
  if (split) return split;
  const half = Math.ceil(texts.length / 2);
  return [
    ...(await translateBatch(adapter, model, texts.slice(0, half), language)),
    ...(await translateBatch(adapter, model, texts.slice(half), language)),
  ];
}

/**
 * Each text translated into `language`, on the chat owner's auxiliary model.
 * 503 where the owner has no model to run it on; 502 where the model failed.
 * An empty answer for a text is taken as no translation and leaves the original.
 */
export async function translateTexts(
  deps: AppDeps,
  owner: AuxiliaryOwner,
  texts: readonly string[],
  language: TranslationLanguage,
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (texts.length === 0) return out;
  const channel = await memoryChannel(deps, owner);
  if (!channel) throw new ApiError(503, 'translation_unavailable', 'Translation is not available');
  try {
    for (const batch of translationBatches(texts)) {
      const translated = await translateBatch(channel.adapter, channel.providerModel, batch, language);
      batch.forEach((text, index) => {
        const result = translated[index]?.trim();
        if (result) out.set(text, result);
      });
    }
  } catch (error) {
    if (error instanceof ApiError) throw error;
    console.error('[translate] call failed', error);
    throw new ApiError(502, 'translation_failed', 'The translation did not come back');
  }
  return out;
}

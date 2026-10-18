import { joinUrl } from '../http.js';
import { applyParameters, withPresetParams, type ModelCapabilities, type ParameterPlaces } from '../params.js';
import { StopFilter } from '../stream.js';
import { textTurns, type TextTurn } from '../stringlize.js';
import type { ChatRequest, LLMAdapter } from '../types.js';
import type { AdapterConfig, ModelFormat } from './format.js';
import { bearer, listOpenAIModels, readChatCompletionsStream } from './openaiChat.js';
import { postJson, watched } from './send.js';
import { capabilitiesOf } from './text.js';

/** RisuAI's Mistral parameters. */
const PLACES: ParameterPlaces = {
  temperature: 'temperature',
  presencePenalty: 'presence_penalty',
  frequencyPenalty: 'frequency_penalty',
  topP: 'top_p',
};
/** RisuAI's flags for its Mistral models: one system prompt first, roles alternating, the user first. */
const REFORMAT: ModelCapabilities = { systemPrompt: 'first', alternateRoles: true, startWithUser: true };

/**
 * RisuAI's own turns for Mistral, after the flags: the first turn the user's
 * or the system's (another role's goes as a system turn, `role:words`), turns
 * of one role in a row joined by a line break, and a system turn after the
 * first as the user's — onto the user turn before it, `\nSystem:…`, or as a
 * user turn of its own, `System:…`.
 */
export function mistralTurns(turns: readonly TextTurn[]): TextTurn[] {
  const out: TextTurn[] = [];
  turns.forEach((turn, index) => {
    if (index === 0) {
      out.push(turn.role === 'assistant' ? { role: 'system', content: `${turn.role}:${turn.content}` } : { ...turn });
      return;
    }
    const last = out.at(-1)!;
    if (last.role === turn.role) last.content += `\n${turn.content}`;
    else if (turn.role === 'system') {
      if (last.role === 'user') last.content += `\nSystem:${turn.content}`;
      else out.push({ role: 'user', content: `System:${turn.content}` });
    } else out.push({ ...turn });
  });
  return out;
}

/** The chat body RisuAI sends Mistral — `safe_prompt` off — streamed, with the stop strings. */
export function mistralBody(req: ChatRequest, config: Pick<AdapterConfig, 'capabilities'>): Record<string, unknown> {
  const stop = (req.stop ?? []).filter((value) => value.trim());
  return applyParameters(
    {
      model: req.model,
      messages: mistralTurns(textTurns(req, capabilitiesOf(REFORMAT, config))),
      safe_prompt: false,
      max_tokens: req.maxTokens,
      stream: true,
      ...(stop.length ? { stop } : {}),
    },
    req,
    PLACES,
  );
}

/**
 * Mistral's own chat API (RisuAI's `Mistral` format): `<base>/chat/completions`
 * with the bearer key and RisuAI's turns; its stream is Chat Completions'
 * (`readChatCompletionsStream`), the reasoning models' `thinking` chunks apart.
 */
function createAdapter(config: AdapterConfig): LLMAdapter {
  return {
    stream(request) {
      const req = withPresetParams(request, config.params);
      return watched(req, async function* (watch) {
        const response = await postJson(config, joinUrl(config.baseUrl, '/chat/completions'), mistralBody(req, config), { ...config.headers }, bearer(config), watch);
        return yield* readChatCompletionsStream(response, watch, new StopFilter(req.stop));
      });
    },
  };
}

export const mistral: ModelFormat = {
  id: 'mistral',
  places: PLACES,
  key: 'required',
  defaultBaseUrl: 'https://api.mistral.ai/v1',
  reformat: REFORMAT,
  createAdapter,
  listModels: listOpenAIModels,
};

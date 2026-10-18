import type { ModelCapabilities } from '../params.js';
import type { StopFilter } from '../stream.js';
import { applyChatTemplate, speakersOf, textTurns, type TextTurn } from '../stringlize.js';
import type { ChatRequest, StreamDelta } from '../types.js';
import type { AdapterConfig } from './format.js';

/**
 * What the formats that send one text share: the model's flags with the
 * preset's over them, a local server's root address, the prompt through the
 * preset's instruct template, and a reply that arrives whole.
 */

/** The format's flags (RisuAI's, for its models) with the preset's own laid over them. */
export const capabilitiesOf = (defaults: ModelCapabilities, config: Pick<AdapterConfig, 'capabilities'>): ModelCapabilities => ({
  ...defaults,
  ...config.capabilities,
});

/**
 * A local server's own address, whatever of its API path was typed after it:
 * `http://localhost:5001/api/v1` and `http://localhost:11434/v1/` are
 * `http://localhost:5001` and `http://localhost:11434`.
 */
export const serverRoot = (base: string): string => base.replace(/\/+$/, '').replace(/\/(?:api(?:\/v1)?|v1)$/, '');

/** The request as one text through the preset's instruct template (RisuAI's `applyChatTemplate`), with its turns and speakers. */
export function templatePrompt(
  req: ChatRequest,
  config: Pick<AdapterConfig, 'capabilities' | 'params'>,
  defaults: ModelCapabilities,
): { prompt: string; turns: TextTurn[]; char: string; user: string } {
  const turns = textTurns(req, capabilitiesOf(defaults, config));
  const { char, user } = speakersOf(req);
  const prompt = applyChatTemplate(turns, {
    ...(config.params.instructTemplate ? { template: config.params.instructTemplate } : {}),
    ...(config.params.jinjaTemplate ? { jinja: config.params.jinjaTemplate } : {}),
    char,
    user,
  });
  return { prompt, turns, char, user };
}

/** A reply that arrived whole, through the stop strings as a streamed one goes. */
export function* whole(text: string, stop: StopFilter): Generator<StreamDelta, void> {
  const out = stop.push(text) + stop.flush();
  if (out) yield { type: 'text', text: out };
}

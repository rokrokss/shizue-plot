export interface StreamDelta {
  type: 'text';
  text: string;
}

export interface StreamDone {
  usage: { promptTokens: number; completionTokens: number };
}

/**
 * One piece of a multimodal turn. A message is either plain text — which is what
 * all but a handful of turns are — or a list of these, and the list is only ever
 * produced by a turn that carries an image.
 */
export type ContentPart =
  | { type: 'text'; text: string }
  /** Anything `fetch` would take: an https URL, or a `data:` URL of the bytes. */
  | { type: 'image'; url: string };

export type MessageContent = string | ContentPart[];

export interface ChatMessage {
  role: 'user' | 'assistant' | 'system';
  content: MessageContent;
}

/** The words of a turn, whatever shape it arrived in. Images contribute nothing. */
export const contentText = (content: MessageContent): string =>
  typeof content === 'string'
    ? content
    : content
        .filter((part): part is Extract<ContentPart, { type: 'text' }> => part.type === 'text')
        .map((part) => part.text)
        .join('\n');

export interface ChatRequest {
  /** Provider-native model name. */
  model: string;
  system: string;
  messages: ChatMessage[];
  maxTokens: number;
  temperature?: number;
  stop?: string[];
  abortSignal?: AbortSignal;
}

export interface LLMAdapter {
  stream(req: ChatRequest): AsyncGenerator<StreamDelta, StreamDone>;
}

export class LLMError extends Error {}

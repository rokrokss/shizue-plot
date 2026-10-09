import { getEncoding, type Tiktoken } from 'js-tiktoken';

let encoder: Tiktoken | undefined;

/**
 * Approximate token count using a single o200k_base encoder.
 * Per-model exact counting is out of scope.
 */
export function countTokens(text: string): number {
  if (!text) return 0;
  encoder ??= getEncoding('o200k_base');
  return encoder.encode(text).length;
}

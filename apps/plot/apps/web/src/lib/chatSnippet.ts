import { isNarration, narrationBody } from '@shizue/core/narration';

/**
 * How a message reads in one line of a list: the narration prefix is markup the
 * reader never sees, the markdown is formatting there is no room to render, and
 * the macros are protocol rather than prose. Nothing here is a parser — a preview
 * that drops a stray asterisk is doing its job.
 */
export function messageSnippet(text: string): string {
  const body = isNarration(text) ? narrationBody(text) : text;
  return body
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    // A link keeps the words, not the address.
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\{\{[^{}]*\}\}/g, '')
    .replace(/```+/g, '')
    .replace(/^\s*[>#-]+\s*/gm, '')
    .replace(/[*_~`]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

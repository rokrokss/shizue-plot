import { Template } from '@huggingface/jinja';
import { DEFAULT_INSTRUCT_TEMPLATE, INSTRUCT_TEMPLATES } from './instructTemplates.js';
import { providerFailure, redact } from './http.js';
import { reformat, type ModelCapabilities } from './params.js';
import { contentText, type ChatRequest } from './types.js';

/**
 * RisuAI's ways of writing a chat as the one text a completion model goes on
 * from, for the formats that take a prompt rather than turns: the instruct
 * templates (`process/templates/chatTemplate.ts` — text-generation-webui,
 * Kobold, Horde), NovelAI's and NovelList's transcripts (`process/models/nai.ts`,
 * `process/stringlize.ts`), the `## Role` prompt of `requestOpenAILegacyInstruct`
 * and the `\n\nHuman:` prompt of the 2024 `requestClaude`; and the strings that
 * end a continuation where it starts another speaker's line (`getStopStrings`,
 * `unstringlizeChat`). Pictures are not sent: a text prompt has no place for
 * them.
 */

/** A turn as the text formats write it: its words only. */
export interface TextTurn {
  role: 'user' | 'assistant' | 'system';
  content: string;
}

/** Who speaks: the request's names, or RisuAI's stand-ins where a side call gives none. */
export const speakersOf = (req: Pick<ChatRequest, 'names'>): { char: string; user: string } => ({
  char: req.names?.char || 'Assistant',
  user: req.names?.user || 'User',
});

/**
 * The request's turns as text: the system text first, then the conversation,
 * arranged by the model's flags (RisuAI's `reformater`, `params.ts` `reformat`).
 */
export function textTurns(req: Pick<ChatRequest, 'system' | 'messages'>, capabilities: ModelCapabilities): TextTurn[] {
  return reformat([...(req.system ? [{ role: 'system' as const, content: req.system }] : []), ...req.messages], capabilities)
    .map((message) => ({ role: message.role, content: contentText(message.content) }));
}

/** Whether the request goes on from a reply already begun (a continue): RisuAI's `arg.continue`. */
export const continues = (turns: readonly TextTurn[]): boolean => turns.at(-1)?.role === 'assistant';

/** What a built-in template needs of the turns before it reads them (RisuAI's `templateEffect`). */
const TEMPLATE_EFFECTS: Readonly<Record<string, readonly ('no_system_messages' | 'alter_user_assistant_roles')[]>> = {
  gemma: ['no_system_messages'],
  mistral: ['no_system_messages', 'alter_user_assistant_roles'],
};

/** A template's source, or a 400 for a name that is none. */
function templateSource(name: string, jinja: string | undefined): string {
  const source = name === 'jinja' ? jinja : INSTRUCT_TEMPLATES[name];
  if (!source) throw providerFailure('template_invalid', 400);
  return source;
}

/**
 * RisuAI's `applyChatTemplate`: the turns through the preset's instruct template
 * (`chatml` where it names none), with the generation prompt on, empty `bos_token`
 * and `eos_token`, and the speakers as `risu_char` and `risu_user`. Gemma's and
 * Mistral's take no system turn (it goes as the user's, `System: …`), and
 * Mistral's wants the roles to alternate. A template that fails — Llama 2's
 * refuses roles that do not alternate — is `template_failed`.
 */
export function applyChatTemplate(
  turns: readonly TextTurn[],
  options: { template?: string; jinja?: string; char: string; user: string },
): string {
  const name = options.template ?? DEFAULT_INSTRUCT_TEMPLATE;
  const source = templateSource(name, options.jinja);
  const effects = TEMPLATE_EFFECTS[name] ?? [];
  const noSystem = effects.includes('no_system_messages');
  const alternate = effects.includes('alter_user_assistant_roles');
  const messages: TextTurn[] = [];
  for (const turn of turns) {
    const message = noSystem && turn.role === 'system' ? { role: 'user' as const, content: `System: ${turn.content}` } : { ...turn };
    if (!alternate) {
      messages.push(message);
    } else if (message.role === 'user') {
      if (messages.length % 2 === 0) messages.push(message);
      else messages[messages.length - 1]!.content += `\n${message.content}`;
    } else if (messages.length % 2 === 1 || messages.length === 0) {
      if (messages.length === 0) messages.push({ role: 'user', content: '' });
      messages.push({ role: 'assistant', content: message.content });
    } else messages[messages.length - 1]!.content += `\n${message.content}`;
  }
  try {
    return new Template(source).render({
      messages,
      add_generation_prompt: true,
      risu_char: options.char,
      risu_user: options.user,
      eos_token: '',
      bos_token: '',
    });
  } catch (error) {
    throw providerFailure('template_failed', 400, redact(error instanceof Error ? error.message : String(error)));
  }
}

/**
 * RisuAI's `getStopStrings` for text-generation-webui: the end markers of the
 * common templates, the user's name and the input prefix of its default
 * formatting (`### Input:`), and every casing of the words a user's line starts
 * with, as `word:`, `<<word>>` and `### word`.
 */
export function oobaStopStrings(user: string): string[] {
  const stops = ['GPT4 User', '</s>', '<|end', '<|im_end', '### Input:', `${user}:`];
  for (const word of ['user', 'human', 'input', 'inst', 'instruction']) {
    for (const cased of [word.toLowerCase(), word.toUpperCase(), word[0]!.toUpperCase() + word.slice(1).toLowerCase()]) {
      stops.push(`${cased}:`, `<<${cased}>>`, `### ${cased}`);
    }
  }
  return [...new Set(stops)];
}

/**
 * RisuAI's `getUnstringlizerChunks`: where a continuation has moved on to
 * another line — a system note, or the character's or the user's name followed
 * by a colon (`normal`) or by a space (`ain`, NovelList's `Name 「…」`). The
 * formats that cut their output there (`unstringlizeChat`) stop at the first.
 */
export function speakerChunks(char: string, user: string, mode: 'normal' | 'ain' = 'normal'): string[] {
  const chunks = ['system note:', 'system:', 'system note：', 'system：'];
  for (const name of [char, user]) {
    if (!name) continue;
    if (mode === 'ain') chunks.push(`${name} `, `${name}　`);
    else chunks.push(`${name}:`, `${name}：`, `${name}: `, `${name}： `);
  }
  return chunks;
}

/**
 * RisuAI's `stringlizeNAIChat` with its default settings (`prebuiltNAIpresets`,
 * `NAIappendName` on, `NAIadventure` off): one turn a line, the character's
 * and the user's turns after their names, a new chat's marker as `⁂`, and the
 * character's name and a colon last for the model to go on from — unless the
 * request goes on from a reply already begun.
 */
export function novelAIPrompt(turns: readonly TextTurn[], char: string, user: string): string {
  const lines = turns.map((turn) => {
    if (turn.role === 'system') return turn.content === '[Start a new chat]' ? '⁂' : turn.content;
    if (turn.role === 'assistant') return `${char}: ${turn.content}`;
    return `${user}: ${turn.content}`;
  });
  return lines.join('\n') + (continues(turns) ? '' : `\n${char}:`);
}

/**
 * RisuAI's `formatToAIN`: a turn's quotes as NovelList writes them — straight
 * double quotes paired into `「…」`, and each quote on its own after the
 * speaker's name; the words around them stand as they are.
 */
function ainLines(name: string, content: string): string[] {
  let quote = 0;
  const text = content.replace(/"/g, () => (++quote % 2 !== 0 ? '「' : '」'));
  const lines: string[] = [];
  const pattern = /「(.*?)」/g;
  let last = 0;
  for (let match = pattern.exec(text); match; match = pattern.exec(text)) {
    if (match.index !== last) lines.push(text.slice(last, match.index));
    lines.push(`${name} 「${match[1]}」`);
    last = match.index + match[0].length;
  }
  if (last < text.length) lines.push(text.slice(last));
  return lines;
}

/**
 * RisuAI's `stringlizeAINChat` for NovelList: a new chat's marker in Japanese,
 * system turns as they are, every quote after its speaker's name, a blank line
 * between, and the character's name and an opening `「` last. (RisuAI's own
 * line adds a stray `NaN` there — `res += + …` — which is not copied.)
 */
export function novelListPrompt(turns: readonly TextTurn[], char: string, user: string): string {
  const lines: string[] = [];
  for (const turn of turns) {
    if (turn.content === '[Start a new chat]') lines.push('[新しいチャットの始まり]');
    else if (turn.role === 'system') lines.push(turn.content);
    else lines.push(...ainLines(turn.role === 'user' ? user : char, turn.content));
  }
  return lines.join('\n\n') + (continues(turns) ? ' 「' : `\n\n${char} 「`);
}

/**
 * RisuAI's `unstringlizeAIN`: NovelList's continuation — read as going on from
 * the character's `「` — cut into its speakers' quotes and the narration between
 * them. The reply is the character's part: everything up to the first quote of
 * the user's, which RisuAI would have added as the user's own message.
 */
export function novelListReply(output: string, char: string, user: string): string {
  const chunks = speakerChunks(char, user, 'ain');
  let data = `${char} 「${output}`;
  for (const tail of [char, user, ...chunks]) {
    if (tail && data.endsWith(tail)) data = data.slice(0, -tail.length);
  }
  const parts: { speaker: string | null; content: string }[] = [];
  let rest = data;
  while (rest.length > 0) {
    let at = -1;
    let speaker: string | null = null;
    for (const chunk of chunks) {
      const index = rest.indexOf(`${chunk}「`);
      if (index >= 0 && (at === -1 || index < at)) {
        at = index;
        speaker = chunk;
      }
    }
    if (at > 0) parts.push({ speaker: null, content: rest.slice(0, at).trim() });
    if (at === -1 || speaker === null) {
      parts.push({ speaker: null, content: rest.trim() });
      break;
    }
    const end = rest.indexOf('」', at + speaker.length);
    if (end === -1) {
      parts.push({ speaker, content: rest.slice(at + speaker.length + 1).trim() });
      break;
    }
    parts.push({ speaker, content: rest.slice(at + speaker.length + 1, end).trim() });
    rest = rest.slice(end + 1);
  }
  const lines: string[] = [];
  for (const part of parts) {
    if (part.speaker === null) {
      if (lines.length === 0) lines.push(part.content);
      else lines[lines.length - 1] += `\n${part.content}`;
    } else if (part.speaker.trim() === user) break;
    else lines.push(`「${part.content}」`);
  }
  return lines.join('\n');
}

/**
 * The prompt of RisuAI's `requestOpenAILegacyInstruct`: each turn with words
 * under a `## User`, `## Assistant` or `## Instruction` heading, and `## Response`
 * last.
 */
export function legacyInstructPrompt(turns: readonly TextTurn[]): string {
  const author = { user: 'User', assistant: 'Assistant', system: 'Instruction' } as const;
  return turns
    .filter((turn) => turn.content.trim())
    .map((turn) => `\n## ${author[turn.role]}\n${turn.content.trim()}`)
    .join('') + '\n## Response\n';
}

/**
 * The prompt of RisuAI's `requestClaude` for Anthropic's Text Completions
 * (RisuAI until 2024-03): `\n\nHuman: `, `\n\nAssistant: ` and `\n\nSystem: `
 * turns — Claude 2.1 and later read a first system turn bare, as their system
 * prompt — then `\n\nAssistant: ` for the model to go on from, unless the last
 * turn is already its, all after the `\n\nHuman: ` the API wants first.
 */
export function claudeLegacyPrompt(turns: readonly TextTurn[], model: string): string {
  const prefix = { assistant: '\n\nAssistant: ', user: '\n\nHuman: ', system: '\n\nSystem: ' } as const;
  const bareSystem = model.startsWith('claude-2') && !model.startsWith('claude-2.0');
  const prompt = turns.map((turn, index) => (bareSystem && index === 0 && turn.role === 'system' ? '' : prefix[turn.role]) + turn.content).join('');
  return `\n\nHuman: ${prompt}${continues(turns) ? '' : '\n\nAssistant: '}`;
}

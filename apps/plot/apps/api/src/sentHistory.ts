/**
 * The branch's turns as the main prompt sends their words, for the sidecar
 * models that read the conversation — the memory's summarizer and its fact
 * extraction, the reply suggestions (ARCHITECTURE
 * §7.3). It is what RisuAI's HypaV3 summarizes: the chat its prompt is built
 * from, each message through `risuChatParser` and the `editprocess` scripts
 * (`processScriptFull`). So a status window or anything else a card's prompt
 * scripts take out of the prompt is out of the transcript too, and a greeting's
 * `{{#when}}` routes read as the chat's variables pick them.
 *
 * The prompt's own path: the cards' prompt scripts in the regex threads
 * (`withPromptScripts`, which every generation runs), then the macros as the
 * assembler reads a history turn's (core `sentHistoryTexts`). A turn neither
 * changes — every turn of a work with no prompt scripts and no macros in its
 * text — reads as stored.
 *
 * The prompt's history helpers live here too (`toHistory`, `promptBranch`,
 * `foldOptionsOf`), so the background readers, which have no generation's
 * context, build theirs as the routes do.
 */
import {
  applyMacros,
  characterName,
  computeVariables,
  DEFAULT_USER_NAME,
  sentHistoryTexts,
  type FoldOptions,
  type HistoryMessage,
  type PromptBranch,
  type PromptCharacter,
  type PromptPlot,
  type Variables,
} from '@shizue/core';
import { promptScriptJob, promptScriptsOf } from '@shizue/core/prompt-scripts';
import { personas, plots, type Chat, type Message, type Persona } from '@shizue/db';
import { eq } from 'drizzle-orm';
import type { AppDeps } from './deps.js';
import { loadMembers } from './hub.js';
import { toPromptCharacters, toPromptPlot } from './plots.js';
import { chatModulesOf } from './readerModules.js';
import { chatDefaultVariables } from './readerPresets.js';
import { runPromptScriptJob } from './regexWorker.js';
import { loadChatGlobalVariables } from './scriptState.js';

/* ----------------------------------------------- the prompt's history */

/**
 * The names every fold of this chat answers `{{user}}` and `{{char}}` with
 * (`FoldOptions`): the persona's name, and the plot's — a message is the work's
 * text, where `{{char}}` is the work. The reader's screen has to fold with the
 * same two, or a value nesting either reads one way there and another here.
 */
export const foldOptionsOf = (plotName: string, persona: Pick<Persona, 'name'> | null): FoldOptions => ({
  user: persona?.name ?? DEFAULT_USER_NAME,
  char: plotName,
});

/**
 * The branch as the assembler takes it: a group reply names its member
 * (`speakerId`), and an untagged character message a script wrote is said by
 * `speaker`.
 */
export const toHistory = (path: Message[], speaker: string | undefined): HistoryMessage[] =>
  path.map((message) => ({
    role: message.role,
    content: message.content,
    id: message.id,
    createdAt: message.createdAt.getTime(),
    ...(message.speakerMemberId !== null ? { speakerId: message.speakerMemberId } : {}),
    ...(speaker !== undefined && message.role === 'assistant' && message.source === 'script' ? { speaker } : {}),
    // Left in, so the chat functions read the stored chat; the assembler sends none of it.
    ...(message.hiddenFromPrompt ? { hidden: true } : {}),
  }));

/**
 * Where a history sits on `branch`, the messages the turn is generated on: its
 * length, and the intro it opened on — a root the chat's openings were written
 * as, numbered by its place among them, the first being -1 as RisuAI numbers
 * them. Approximate where a reroll of the opening added a root of its own.
 *
 * On the first one, the greeting reads as `firstMessage` where the scripts
 * rewrote it (`setCharacterFirstMessage`): RisuAI sends its greeting from the
 * character while the chat is on the first (`fmIndex` -1), and only then.
 */
export function promptBranch(all: readonly Message[], branch: readonly Message[], firstMessage?: string): PromptBranch {
  const root = branch[0];
  const swipes = swipesOf(all, branch.at(-1));
  if (!root || root.parentId !== null || root.role !== 'assistant') {
    return { length: branch.length, ...(swipes ? { swipes } : {}) };
  }
  const openings = all.filter((message) => message.parentId === null && message.role === 'assistant');
  const index = openings.indexOf(root) - 1;
  const text = index === -1 && firstMessage !== undefined ? firstMessage : root.content;
  return { length: branch.length, greeting: { text, index }, ...(swipes ? { swipes } : {}) };
}

/**
 * A reply's versions as SillyTavern's swipes (`PromptBranch.swipes`): the
 * replies beside it under the same parent, and which of them it is. The
 * reader's turns have none, as there.
 */
function swipesOf(all: readonly Message[], last: Message | undefined): PromptBranch['swipes'] {
  if (!last || last.role !== 'assistant') return undefined;
  const siblings = all.filter((message) => message.parentId === last.parentId && message.role === 'assistant');
  return { count: siblings.length, current: Math.max(0, siblings.indexOf(last)) };
}

/* ------------------------------------------------- the prompt scripts */

/** What the cards' prompt scripts are read with: the work, its roster, and what their macros read. */
export interface ScriptedWork {
  plot: Pick<PromptPlot, 'name' | 'modules'>;
  characters: readonly PromptCharacter[];
  userName: string;
  variables: Variables;
  globalVariables?: Variables;
}

/**
 * The history with what the cards' prompt scripts make of it: RisuAI's
 * `editprocess` and SillyTavern's prompt-only regex, read off every member's
 * card in roster order — a member sent off the stage too, since the history
 * they rewrite is still the work's. Each turn they change carries the result as
 * its `promptContent`; the stored turns, and what the lore scans, stay as they
 * are. The macros a script's pattern is matched with are expanded here, for the
 * card it is on; everything else of a script runs in the pool's threads, which
 * bound it (`regexWorker.ts`). `upTo` rewrites only the first that many turns,
 * the rest standing where they are for the turns' positions — what a reader of
 * an early stretch of a long branch asks, so the threads' clock is spent on
 * what a prompt's history would hold.
 */
export async function withPromptScripts(
  history: HistoryMessage[],
  work: ScriptedWork,
  branch: PromptBranch,
  upTo = history.length,
): Promise<HistoryMessage[]> {
  if (history.length === 0) return history;
  // The chat's modules once, on the first member's list — RisuAI's `processScript`
  // runs the character's `customscript` and the modules' regex as one list, which
  // `<order N>` sorts together — read as the first member's, the work's stand-in.
  const moduleRegex = (work.plot.modules ?? []).flatMap((module) => (Array.isArray(module.regex) ? module.regex : []));
  const cards = work.characters.map((member) => member.card.extensions ?? {});
  if (moduleRegex.length > 0) {
    const first = cards[0] ?? {};
    const risu = first['risuai'] !== null && typeof first['risuai'] === 'object' ? (first['risuai'] as Record<string, unknown>) : {};
    const own = Array.isArray(risu['customScripts']) ? risu['customScripts'] : [];
    cards[0] = { ...first, risuai: { ...risu, customScripts: [...own, ...moduleRegex] } };
  }
  const charOf = (index: number): string => {
    const member = work.characters[index] ?? work.characters[0];
    return member ? characterName(member) : work.plot.name;
  };
  const scripts = promptScriptsOf(cards.map((extensions) => ({ extensions })), (text, index) =>
    applyMacros(text, {
      char: charOf(index),
      user: work.userName,
      variables: work.variables,
      ...(work.globalVariables ? { globalVariables: work.globalVariables } : {}),
    }),
  );
  if (scripts.length === 0) return history;
  const job = promptScriptJob(history, scripts, branch);
  const texts = await runPromptScriptJob({ ...job, messages: job.messages.slice(0, upTo) });
  return history.map((turn, index) =>
    texts[index] === undefined || texts[index] === turn.content ? turn : { ...turn, promptContent: texts[index] },
  );
}

/* ------------------------------------------------- the sent words */

/** What the sent words of a chat's turns are read with — a generation's context, or `loadSentView`'s. */
export interface SentView extends ScriptedWork {
  plot: PromptPlot;
  characters: PromptCharacter[];
  personaText: string;
  /** The whole branch the turns are on (`promptBranch`). */
  branch: PromptBranch;
  /** The chat id, `{{pick}}`'s draw. */
  seed: string;
}

/**
 * What a background reader of a chat — no request, no generation — reads its
 * turns' sent words with: the work with the chat's modules, the roster with the
 * members sent off the stage marked, the persona, the chat's variables at the
 * end of `path` and the work's globals — the roster as the card's scripts left
 * it, which is the roster itself.
 */
export async function loadSentView(
  deps: AppDeps,
  chat: Chat,
  path: readonly Message[],
  all: readonly Message[],
): Promise<SentView> {
  const [plot] = await deps.db.select().from(plots).where(eq(plots.id, chat.plotId)).limit(1);
  if (!plot) throw new Error(`chat ${chat.id} has no plot`);
  const { modules } = await chatModulesOf(deps, chat, plot);
  const members = await loadMembers(deps.db, plot.id);
  const [persona] = chat.personaId
    ? await deps.db.select().from(personas).where(eq(personas.id, chat.personaId)).limit(1)
    : [];
  return {
    plot: toPromptPlot(plot, chat, modules),
    characters: toPromptCharacters(members, new Set(chat.absentCharacterIds ?? [])),
    userName: persona?.name ?? DEFAULT_USER_NAME,
    personaText: persona?.description ?? '',
    variables: computeVariables(path, await chatDefaultVariables(deps, chat, plot), foldOptionsOf(plot.name, persona ?? null)),
    globalVariables: await loadChatGlobalVariables(deps, chat),
    branch: promptBranch(all, path),
    seed: chat.id,
  };
}

/**
 * The sent words of the turns of `path` from `from` up to `to`, by message id —
 * only those that differ from the stored text. They are read as the start of a
 * history running to the branch's end, as a prompt's does, so the scripts and
 * the chat functions count each turn where it stands (`chat_index`, depth,
 * `{{lastmessageid}}`); the turns after `to` are only counted.
 */
export async function sentTexts(
  view: SentView,
  path: readonly Message[],
  from: number,
  to: number,
): Promise<Map<string, string>> {
  const tail = path.slice(from);
  const count = to - from;
  const scripted = await withPromptScripts(toHistory(tail, undefined), view, view.branch, count);
  const texts = sentHistoryTexts({ ...view, history: scripted, upTo: count });
  const changed = new Map<string, string>();
  tail.slice(0, count).forEach((message, at) => {
    if (texts[at] !== undefined && texts[at] !== message.content) changed.set(message.id, texts[at]);
  });
  return changed;
}

/**
 * `messages` — turns of the branch `path` — with their sent words in place of
 * the stored text, for a sidecar transcript (`transcriptOf`). `view` may be a
 * loader, called only when there are turns to read. Turns not all on `path`
 * read as stored, and so does everything where the view fails to load or read
 * (said in the log): the transcript as it read before.
 */
export async function asSent(
  view: SentView | (() => Promise<SentView>),
  path: readonly Message[],
  messages: Message[],
): Promise<Message[]> {
  const position = new Map(path.map((message, at) => [message.id, at]));
  if (messages.length === 0 || messages.some((message) => !position.has(message.id))) return messages;
  const at = messages.map((message) => position.get(message.id)!);
  try {
    const sent = await sentTexts(typeof view === 'function' ? await view() : view, path, Math.min(...at), Math.max(...at) + 1);
    return messages.map((message) => {
      const text = sent.get(message.id);
      return text === undefined ? message : { ...message, content: text };
    });
  } catch (error) {
    console.warn('[sent] reading the turns as the prompt sends them failed; the transcript reads them as stored', error);
    return messages;
  }
}

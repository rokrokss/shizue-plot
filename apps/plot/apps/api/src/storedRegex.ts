/**
 * SillyTavern's regex scripts with neither `promptOnly` nor `markdownOnly`,
 * which rewrite a turn as it is stored rather than as it is sent or shown
 * (`storedTextScriptsOf` in @shizue/core). ST runs them through
 * `getRegexedString` with no depth — so their depth bounds never apply here —
 * at four places, which the API's writes mirror:
 *
 *   - the reader's turn, as it is sent (`sendMessageAsUser`, `USER_INPUT`);
 *   - a reply, as it is stored (`cleanUpMessage`, `AI_OUTPUT`) — on a continue
 *     over the whole message, which is what ST cleans up there;
 *   - a chat's greetings, as it opens (`getFirstMessage`, `AI_OUTPUT`);
 *   - an edit, by the scripts with `runOnEdit` alone (`updateMessage`, with
 *     `isEdit`) — on the placement of the message edited: a narration is ST's
 *     narrator's (`SLASH_COMMAND`).
 *
 * Only a card ST wrote carries `regex_scripts`, so every other work stores its
 * turns exactly as before. A script runs in the same bounded threads as the
 * prompt's (`regexWorker.ts`): a pattern that hangs is stopped and skipped, and
 * the text is stored as it was.
 */
import { applyMacros, characterName, type PromptCharacter, type Variables } from '@shizue/core';
import { storedTextScriptsOf, USER_INPUT } from '@shizue/core/prompt-scripts';
import { runPromptScriptJob } from './regexWorker.js';

/** ST's `regex_placement` of a stored text: the reader's turn, a reply, a narration. */
export type StoredPlacement = 1 | 2 | 3;

export interface StoredRegexInput {
  /** The roster in the creator's order, as the prompt reads it — whose cards the scripts are on. */
  characters: readonly Pick<PromptCharacter, 'name' | 'card'>[];
  userName: string;
  /** What `{{getvar}}` in a pattern reads; absent, it is left as written. */
  variables?: Variables;
  globalVariables?: Variables;
}

/**
 * The text as the cards' stored-text scripts leave it, in roster order — each
 * script's macros expanded for its own card, as ST's own text reads them. The
 * text itself when no card has one, or when every one that might is stopped.
 */
export async function regexStoredText(
  text: string,
  placement: StoredPlacement,
  input: StoredRegexInput,
  { edit = false }: { edit?: boolean } = {},
): Promise<string> {
  if (!text) return text;
  const cards = input.characters.map((member) => ({ extensions: member.card.extensions ?? {} }));
  // A cheap look first: the macro engine is not woken for a roster with nothing to run.
  if (storedTextScriptsOf(cards, undefined, { edit }).length === 0) return text;
  const scripts = storedTextScriptsOf(
    cards,
    (source, index) => {
      const member = input.characters[index];
      return applyMacros(source, {
        char: member ? characterName(member) : '',
        user: input.userName,
        ...(input.variables ? { variables: input.variables } : {}),
        ...(input.globalVariables ? { globalVariables: input.globalVariables } : {}),
        tavern: { sillyTavern: true },
      });
    },
    { edit },
  );
  const [result] = await runPromptScriptJob({
    scripts,
    messages: [{ text, role: placement === USER_INPUT ? 'user' : 'assistant', chatIndex: 0, placement }],
  });
  return result ?? text;
}

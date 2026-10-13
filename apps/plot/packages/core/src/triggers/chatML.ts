/** A turn a script sends to the model. */
export interface ScriptChatTurn {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

const STARTER = '<|im_start|>';
const SEPARATOR = '<|im_sep|>';
const ENDER = '<|im_end|>';
const ROLES = ['user', 'system', 'assistant'] as const;

/**
 * RisuAI's ChatML reader (`parser/chatML.ts`), which `runLLM` and `v2RunLLM`
 * use so a script can send a whole conversation rather than one line. Text that
 * starts with `<|im_start|>` is split into turns; each opens with its role and
 * either `<|im_sep|>` or a space or newline, and may close with `<|im_end|>`. A
 * turn with no role it knows is a user turn, as in RisuAI. Anything that does
 * not start that way is not ChatML (null), and the caller sends it as one user
 * turn. `<Thoughts>…</Thoughts>` is taken out of a turn, as RisuAI keeps it apart
 * from the content.
 *
 * RisuAI also reads each turn as CBS a second time; here the effect's text
 * already was, once, and a second pass would run the macros a turn quotes.
 */
export function parseChatML(data: string): ScriptChatTurn[] | null {
  const trimmed = data.trim();
  if (!trimmed.startsWith(STARTER)) return null;
  return trimmed
    .split(STARTER)
    .filter((part) => part !== '')
    .map((part) => {
      let role: ScriptChatTurn['role'] = 'user';
      let text = part;
      const named = ROLES.find(
        (candidate) =>
          text.startsWith(candidate + SEPARATOR) ||
          text.startsWith(`${candidate} `) ||
          text.startsWith(`${candidate}\n`),
      );
      if (named) {
        role = named;
        text = text.startsWith(named + SEPARATOR)
          ? text.slice(named.length + SEPARATOR.length)
          : text.slice(named.length + 1);
      }
      text = text.trim();
      if (text.endsWith(ENDER)) text = text.slice(0, -ENDER.length);
      return { role, content: text.replace(/<Thoughts>(.+)<\/Thoughts>/gs, '') };
    });
}

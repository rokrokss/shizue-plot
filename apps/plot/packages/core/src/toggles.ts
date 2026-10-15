/**
 * RisuAI's custom toggles (`customModuleToggle`): a few lines of
 * `key=label[=type[=options]]` a module or a character carries, which RisuAI
 * draws in its sidebar (`Toggles.svelte`) and whose values are global chat
 * variables named `toggle_<key>` — what `{{getglobalvar::toggle_x}}`,
 * `{{#when::toggle::x}}` and a script's `getGlobalVar` read.
 *
 * Read exactly as RisuAI's `parseToggleSyntax` reads them (`util.ts`): one line
 * each, split on every `=` (`[key, value, type, option]`); `group`, `groupEnd`
 * and `divider` stand whatever else the line says; `caption` needs its text;
 * anything else needs a key and a label and is a `select`, `text` or `textarea`
 * by its third field, else a checkbox. A select's options are the fourth field
 * split on commas, and its value is the chosen option's index as text; a
 * checkbox is `'1'` when on and `'0'` (or unset) when off.
 *
 * Dependency-free, so the chat page can import it (`@shizue/core/toggles`).
 */

export type ToggleType = 'select' | 'text' | 'textarea' | 'caption' | 'divider' | 'group' | 'groupEnd';

/** One line of the syntax as RisuAI reads it (`sidebarToggle`). `type` absent is a checkbox. */
export interface ToggleItem {
  key: string;
  /** The label — a divider's or a group's title, a caption's text. */
  value: string;
  type?: ToggleType;
  /** A select's options, in order; its value is the index. */
  options?: string[];
}

/** A group with the toggles between its `group` and its `groupEnd` (`sidebarToggleGroup`). */
export interface ToggleGroup extends ToggleItem {
  type: 'group';
  children: ToggleItem[];
}

export type ToggleEntry = ToggleItem | ToggleGroup;

/** RisuAI's `parseToggleSyntax`, line for line. */
export function parseToggleSyntax(template: string | null | undefined): ToggleItem[] {
  if (!template) return [];
  const items: ToggleItem[] = [];
  for (const line of template.split('\n')) {
    const [key = '', value, type, option] = line.split('=');
    if (type === 'group' || type === 'groupEnd' || type === 'divider') {
      items.push({ key, value: value ?? '', type });
    } else if (type === 'caption' && value) {
      items.push({ key, value, type });
    } else if (key && value) {
      items.push({
        key,
        value,
        ...(type === 'select' || type === 'text' || type === 'textarea' ? { type } : {}),
        options: option?.split(',') ?? [],
      });
    }
  }
  return items;
}

/**
 * The toggles as RisuAI's sidebar lays them out: a `group` opens a group, the
 * toggles after it are its children until a `groupEnd`, which itself is not
 * drawn (a `group` inside an open one starts the next group beside it). A
 * divider repeating the one just before it in the same list (same label) is
 * drawn once. A group nothing went into stays: RisuAI's sidebar draws it as a
 * checkbox of its key (`isEmptyGroup`), its `{#if}` falling through to that.
 */
export function groupToggles(items: readonly ToggleItem[]): ToggleEntry[] {
  const grouped: ToggleEntry[] = [];
  let open: ToggleGroup | null = null;
  for (const item of items) {
    if (item.type === 'group') {
      open = { ...item, type: 'group', children: [] };
      grouped.push(open);
    } else if (item.type === 'groupEnd') {
      open = null;
    } else if (open) {
      open.children.push(item);
    } else {
      grouped.push(item);
    }
  }
  const drawn = <T extends ToggleEntry>(list: readonly T[]): T[] =>
    list.flatMap((entry, index) => {
      const before = list[index - 1];
      if (entry.type === 'divider' && before?.type === 'divider' && before.value === entry.value) return [];
      if (isToggleGroup(entry)) return [{ ...entry, children: drawn(entry.children) }];
      return [entry];
    });
  return drawn(grouped);
}

export const isToggleGroup = (entry: ToggleEntry): entry is ToggleGroup =>
  entry.type === 'group' && 'children' in entry;

/** A group with nothing in it, which RisuAI's sidebar draws as a checkbox. */
export const isEmptyGroup = (entry: ToggleEntry): boolean => isToggleGroup(entry) && entry.children.length === 0;

/** The global variable a toggle's value lives in. */
export const toggleVariable = (key: string): string => `toggle_${key}`;

/**
 * The toggle text RisuAI's sidebar draws for a chat (`Toggles.svelte`): the
 * prompt preset's own (`customPromptTemplateToggle` — here the chat's reader
 * preset's), then the modules' toggles, each on its own lines in the modules'
 * order (`getModuleToggles`), then the character's own (`customModuleToggle`, a
 * card's `extensions.risuai.toggles`).
 */
export function chatToggleText(
  modules: readonly { toggles?: string }[],
  character: readonly string[],
  preset = '',
): string {
  let text = '';
  for (const module of modules) if (module.toggles) text += `\n${module.toggles}\n`;
  return `${preset}\n${text}\n${character.filter(Boolean).join('\n')}`;
}

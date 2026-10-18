import {
  groupOtherBotRoleOf,
  normalizeFormatingOrder,
  normalizePresetRegex,
  normalizePromptSettings,
  normalizePromptTemplate,
  READER_PRESET_INTEGRATION_MAX,
  READER_PRESET_NAME_MAX,
  READER_PRESET_REGEX_MAX,
  READER_PRESET_TEMPLATE_ITEMS_MAX,
  READER_PRESET_TEXT_MAX,
  type FormatOrderItem,
  type GroupOtherBotRole,
  type PromptSettings,
  type PromptTemplateItem,
} from '@shizue/core';
import { readerPresets, type ReaderPreset } from '@shizue/db';
import { and, asc, eq } from 'drizzle-orm';
import { Hono } from 'hono';
import type { AppDeps, AppEnv } from '../deps.js';
import { badRequest } from '../errors.js';
import { loadOwnedReaderPreset } from '../readerPresets.js';
import { optionalString, readJsonBody, requireUuidParam } from '../util.js';

/** A preset as its owner sees it — their own text, and nothing else. */
const toReaderPresetJson = (preset: ReaderPreset) => ({
  id: preset.id,
  name: preset.name,
  /** RisuAI's `mainPrompt`. */
  main: preset.main,
  globalNote: preset.globalNote,
  jailbreak: preset.jailbreak,
  /** RisuAI's `formatingOrder`; null for its default. */
  formatingOrder: preset.formatingOrder == null ? null : normalizeFormatingOrder(preset.formatingOrder),
  /** RisuAI's prompt template; null for none. */
  promptTemplate: normalizePromptTemplate(preset.promptTemplate),
  groupTemplate: preset.groupTemplate,
  groupOtherBotRole: groupOtherBotRoleOf(preset.groupOtherBotRole),
  /** RisuAI's preset toggles (`customPromptTemplateToggle`), drawn first among a chat's toggles. */
  toggles: preset.toggles,
  /** RisuAI's `moduleIntergration`: the namespaces whose library modules a chat on it turns on. */
  moduleIntegration: preset.moduleIntegration,
  /** RisuAI's `templateDefaultVariables`: `key=value` lines a chat on it reads for a variable nothing set. */
  defaultVariables: preset.defaultVariables,
  /** RisuAI's `promptSettings`; null for every one off. */
  promptSettings: normalizePromptSettings(preset.promptSettings) ?? null,
  /** RisuAI's preset regex, its scripts as saved; [] for none. */
  regex: normalizePresetRegex(preset.regex),
  createdAt: preset.createdAt.toISOString(),
  updatedAt: preset.updatedAt.toISOString(),
});

interface PresetFields {
  name?: string;
  main?: string;
  globalNote?: string;
  jailbreak?: string;
  formatingOrder?: FormatOrderItem[] | null;
  promptTemplate?: PromptTemplateItem[] | null;
  groupTemplate?: string;
  groupOtherBotRole?: GroupOtherBotRole;
  toggles?: string;
  moduleIntegration?: string;
  defaultVariables?: string;
  promptSettings?: PromptSettings | null;
  regex?: Record<string, unknown>[] | null;
}

/** `promptSettings`: null for every one off, else RisuAI's settings (unknown ones dropped). */
function settingsOf(value: unknown): PromptSettings | null {
  if (value === null) return null;
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw badRequest('invalid_request', 'promptSettings must be an object or null');
  }
  const settings = normalizePromptSettings(value) ?? null;
  if ((settings?.postEndInnerFormat?.length ?? 0) > READER_PRESET_TEXT_MAX) {
    throw badRequest('reader_preset_limit', `postEndInnerFormat must be at most ${READER_PRESET_TEXT_MAX} characters`);
  }
  return settings;
}

/** `regex`: null for none, else RisuAI's scripts, each an object, all within the caps. */
function regexOf(value: unknown): Record<string, unknown>[] | null {
  if (value === null) return null;
  if (!Array.isArray(value)) throw badRequest('invalid_request', 'regex must be an array or null');
  if (value.length > READER_PRESET_REGEX_MAX) {
    throw badRequest('reader_preset_limit', `regex may hold at most ${READER_PRESET_REGEX_MAX} scripts`);
  }
  const scripts = normalizePresetRegex(value);
  if (scripts.some((script) => JSON.stringify(script).length > READER_PRESET_TEXT_MAX)) {
    throw badRequest('reader_preset_limit', `a regex script must be at most ${READER_PRESET_TEXT_MAX} characters`);
  }
  return scripts.length > 0 ? scripts : null;
}

/** `formatingOrder`: null for RisuAI's default, else an array of its block names. */
function orderOf(value: unknown): FormatOrderItem[] | null {
  if (value === null) return null;
  if (!Array.isArray(value)) throw badRequest('invalid_request', 'formatingOrder must be an array or null');
  return normalizeFormatingOrder(value);
}

/** `promptTemplate`: null for none, else RisuAI's items (unknown ones dropped), each text within the cap. */
function templateOf(value: unknown): PromptTemplateItem[] | null {
  if (value === null) return null;
  if (!Array.isArray(value)) throw badRequest('invalid_request', 'promptTemplate must be an array or null');
  if (value.length > READER_PRESET_TEMPLATE_ITEMS_MAX) {
    throw badRequest('reader_preset_limit', `promptTemplate may hold at most ${READER_PRESET_TEMPLATE_ITEMS_MAX} items`);
  }
  const items = normalizePromptTemplate(value) ?? [];
  for (const item of items) {
    const texts = [
      'text' in item ? item.text : '',
      'innerFormat' in item ? (item.innerFormat ?? '') : '',
      'defaultText' in item ? (item.defaultText ?? '') : '',
    ];
    if (texts.some((text) => text.length > READER_PRESET_TEXT_MAX)) {
      throw badRequest('reader_preset_limit', `a template item's text must be at most ${READER_PRESET_TEXT_MAX} characters`);
    }
  }
  return items;
}

/** The fields a body may set, each checked against its cap; `name` may not be blank. */
function presetFields(body: Record<string, unknown>): PresetFields {
  const name = optionalString(body, 'name')?.trim();
  const main = optionalString(body, 'main');
  const globalNote = optionalString(body, 'globalNote');
  const jailbreak = optionalString(body, 'jailbreak');
  const groupTemplate = optionalString(body, 'groupTemplate');
  const groupOtherBotRole = optionalString(body, 'groupOtherBotRole');
  if (groupOtherBotRole !== undefined && groupOtherBotRoleOf(groupOtherBotRole) !== groupOtherBotRole) {
    throw badRequest('invalid_request', 'groupOtherBotRole must be user, assistant or system');
  }
  const formatingOrder = 'formatingOrder' in body ? orderOf(body['formatingOrder']) : undefined;
  const promptTemplate = 'promptTemplate' in body ? templateOf(body['promptTemplate']) : undefined;
  const toggles = optionalString(body, 'toggles');
  const moduleIntegration = optionalString(body, 'moduleIntegration');
  const defaultVariables = optionalString(body, 'defaultVariables');
  const promptSettings = 'promptSettings' in body ? settingsOf(body['promptSettings']) : undefined;
  const regex = 'regex' in body ? regexOf(body['regex']) : undefined;
  if (name === '') throw badRequest('invalid_request', 'name must not be blank');
  if (name !== undefined && name.length > READER_PRESET_NAME_MAX) {
    throw badRequest('reader_preset_limit', `name must be at most ${READER_PRESET_NAME_MAX} characters`);
  }
  for (const [key, text] of [
    ['main', main],
    ['globalNote', globalNote],
    ['jailbreak', jailbreak],
    ['groupTemplate', groupTemplate],
    ['toggles', toggles],
    ['defaultVariables', defaultVariables],
  ] as const) {
    if (text !== undefined && text.length > READER_PRESET_TEXT_MAX) {
      throw badRequest('reader_preset_limit', `${key} must be at most ${READER_PRESET_TEXT_MAX} characters`);
    }
  }
  if (moduleIntegration !== undefined && moduleIntegration.length > READER_PRESET_INTEGRATION_MAX) {
    throw badRequest(
      'reader_preset_limit',
      `moduleIntegration must be at most ${READER_PRESET_INTEGRATION_MAX} characters`,
    );
  }
  return {
    ...(name !== undefined ? { name } : {}),
    ...(main !== undefined ? { main } : {}),
    ...(globalNote !== undefined ? { globalNote } : {}),
    ...(jailbreak !== undefined ? { jailbreak } : {}),
    ...(formatingOrder !== undefined ? { formatingOrder } : {}),
    ...(promptTemplate !== undefined ? { promptTemplate } : {}),
    ...(groupTemplate !== undefined ? { groupTemplate } : {}),
    ...(groupOtherBotRole !== undefined ? { groupOtherBotRole: groupOtherBotRoleOf(groupOtherBotRole) } : {}),
    ...(toggles !== undefined ? { toggles } : {}),
    ...(moduleIntegration !== undefined ? { moduleIntegration } : {}),
    ...(defaultVariables !== undefined ? { defaultVariables } : {}),
    ...(promptSettings !== undefined ? { promptSettings } : {}),
    ...(regex !== undefined ? { regex } : {}),
  };
}

/**
 * The reader's own presets (§10): list, create, edit, delete. There is no
 * export — a preset is the reader's text, and the import that fills one runs in
 * the browser (`@shizue/core/reader-preset`), which sends only what it took.
 */
export function readerPresetRoutes(deps: AppDeps): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  app.get('/', async (c) => {
    const rows = await deps.db
      .select()
      .from(readerPresets)
      .where(eq(readerPresets.userId, c.get('userId')))
      .orderBy(asc(readerPresets.createdAt), asc(readerPresets.id));
    return c.json(rows.map(toReaderPresetJson));
  });

  app.post('/', async (c) => {
    const userId = c.get('userId');
    const fields = presetFields(await readJsonBody(c));
    if (fields.name === undefined) throw badRequest('invalid_request', 'name must be a string');

    const [created] = await deps.db
      .insert(readerPresets)
      .values({
        userId,
        name: fields.name!,
        main: fields.main ?? '',
        globalNote: fields.globalNote ?? '',
        jailbreak: fields.jailbreak ?? '',
        formatingOrder: fields.formatingOrder ?? null,
        promptTemplate: fields.promptTemplate ?? null,
        groupTemplate: fields.groupTemplate ?? '',
        groupOtherBotRole: fields.groupOtherBotRole ?? 'user',
        toggles: fields.toggles ?? '',
        moduleIntegration: fields.moduleIntegration ?? '',
        defaultVariables: fields.defaultVariables ?? '',
        promptSettings: fields.promptSettings ?? null,
        regex: fields.regex ?? null,
      })
      .returning();
    return c.json(toReaderPresetJson(created!), 201);
  });

  app.put('/:id', async (c) => {
    const id = requireUuidParam(c);
    const userId = c.get('userId');
    await loadOwnedReaderPreset(deps, id, userId);
    const fields = presetFields(await readJsonBody(c));
    const [updated] = await deps.db
      .update(readerPresets)
      .set({ ...fields, updatedAt: new Date() })
      .where(and(eq(readerPresets.id, id), eq(readerPresets.userId, userId)))
      .returning();
    return c.json(toReaderPresetJson(updated!));
  });

  app.delete('/:id', async (c) => {
    const id = requireUuidParam(c);
    const userId = c.get('userId');
    await loadOwnedReaderPreset(deps, id, userId);
    // Chats that picked it go back to none: chats.reader_preset_id is set null.
    await deps.db.delete(readerPresets).where(and(eq(readerPresets.id, id), eq(readerPresets.userId, userId)));
    return c.body(null, 204);
  });

  return app;
}

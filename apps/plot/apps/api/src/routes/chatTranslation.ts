/**
 * The chat's translations (ARCHITECTURE §7.8, §10): what the reader's browser
 * shows translated, cached per message and language, and what they write,
 * translated into the work's language before it is sent.
 *
 * Display only. The model never reads a translation: the stored messages and the
 * prompt stay in the card's language, and a translation is made after a reply
 * has finished arriving — none of these routes takes the generation slot, and
 * none is ever waited on by a generation.
 */
import { applyParts, inputParts, isTranslationLanguage, partTexts, type TranslationLanguage } from '@shizue/core';
import { messages, messageTranslations } from '@shizue/db';
import { and, eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { createHash } from 'node:crypto';
import type { AppDeps, AppEnv } from '../deps.js';
import { badRequest, notFound } from '../errors.js';
import { loadVisiblePlot } from '../hub.js';
import { translateTexts, withTranslationSlot } from '../translate.js';
import { optionalBoolean, readJsonBody, requireString, requireUuidParam } from '../util.js';
import { loadOwnedChat } from './chats.js';

/** How many texts one message may ask about, and how much of them in all. */
export const MAX_TRANSLATION_TEXTS = 1000;
export const MAX_TRANSLATION_CHARS = 100_000;
/** What the reader may have translated before sending — a turn, not a document. */
export const MAX_INPUT_TRANSLATION_CHARS = 20_000;

/** A message's text as the cache knows it: a row made from other text is stale. */
const contentHash = (content: string): string => createHash('sha256').update(content).digest('hex');

function requireLanguage(value: unknown): TranslationLanguage {
  if (!isTranslationLanguage(value)) throw badRequest('invalid_request', 'language must be one of ko, en, ja');
  return value;
}

export function chatTranslationRoutes(deps: AppDeps): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  /**
   * Every translation the chat holds in one language, by message — what a page
   * reads once when it opens, so a reload asks the model for nothing it already
   * translated. A row whose message has changed since is left out.
   */
  app.get('/:id/translations', async (c) => {
    const chat = await loadOwnedChat(deps, requireUuidParam(c), c.get('userId'));
    const language = requireLanguage(c.req.query('language'));
    const rows = await deps.db
      .select({ messageId: messageTranslations.messageId, contentHash: messageTranslations.contentHash, texts: messageTranslations.texts, content: messages.content })
      .from(messageTranslations)
      .innerJoin(messages, eq(messages.id, messageTranslations.messageId))
      .where(and(eq(messages.chatId, chat.id), eq(messageTranslations.language, language)));
    return c.json({
      translations: Object.fromEntries(
        rows.filter((row) => row.contentHash === contentHash(row.content)).map((row) => [row.messageId, row.texts]),
      ),
    });
  });

  /**
   * The texts a message shows, translated: from the cache where it has them,
   * from the chat's auxiliary model for the rest (RisuAI's `translateLLM` with
   * its `LLMCacheStorage`). The browser cuts the message into these texts, by
   * RisuAI's rules for what is translated; the cache keeps what this request
   * asked about, for as long as the message's text is what it was.
   *
   * `regenerate: true` is RisuAI's 다시 번역 (`translateLLM`'s `regenerate`):
   * every text asked about goes to the model again, whatever the cache holds,
   * and what comes back takes its place there.
   */
  app.post('/:id/messages/:messageId/translation', async (c) => {
    const userId = c.get('userId');
    const chat = await loadOwnedChat(deps, requireUuidParam(c), userId);
    const messageId = requireUuidParam(c, 'messageId');
    const body = await readJsonBody(c);
    const language = requireLanguage(body['language']);
    const regenerate = optionalBoolean(body, 'regenerate') ?? false;
    const texts = body['texts'];
    if (!Array.isArray(texts) || texts.some((text) => typeof text !== 'string' || text.trim() === '')) {
      throw badRequest('invalid_request', 'texts must be a list of non-empty strings');
    }
    const asked = [...new Set(texts as string[])];
    if (asked.length > MAX_TRANSLATION_TEXTS || asked.reduce((sum, text) => sum + text.length, 0) > MAX_TRANSLATION_CHARS) {
      throw badRequest('translation_too_long', 'Too much text to translate at once');
    }

    const { hash, cached } = await cachedTranslation(chat.id, messageId, language);
    const missing = regenerate ? asked : asked.filter((text) => cached[text] === undefined);
    if (missing.length === 0) {
      return c.json({ texts: Object.fromEntries(asked.map((text) => [text, cached[text]!])) });
    }

    const made = await withTranslationSlot(userId, () => translateTexts(deps, chat, missing, language));
    const result: Record<string, string> = {};
    for (const text of asked) {
      const translated = regenerate ? (made.get(text) ?? cached[text]) : (cached[text] ?? made.get(text));
      if (translated !== undefined) result[text] = translated;
    }
    // What this message shows now: a text it no longer shows is not kept.
    await keepTranslation(messageId, language, hash, result);
    return c.json({ texts: result });
  });

  /**
   * RisuAI's 번역 수정: the reader's own wording for texts of a message, kept in
   * the cache in place of the model's (`setLLMCache`), for as long as the
   * message's text is what it was. Only the texts sent change; the others the
   * cache holds stay. No model is asked.
   */
  app.put('/:id/messages/:messageId/translation', async (c) => {
    const chat = await loadOwnedChat(deps, requireUuidParam(c), c.get('userId'));
    const messageId = requireUuidParam(c, 'messageId');
    const body = await readJsonBody(c);
    const language = requireLanguage(body['language']);
    const texts = body['texts'];
    if (
      texts === null ||
      typeof texts !== 'object' ||
      Array.isArray(texts) ||
      Object.entries(texts).some(([text, translated]) => text.trim() === '' || typeof translated !== 'string' || translated.trim() === '')
    ) {
      throw badRequest('invalid_request', 'texts must map non-empty strings to non-empty strings');
    }
    const corrected = texts as Record<string, string>;
    const entries = Object.entries(corrected);
    const chars = (pick: (entry: [string, string]) => string) => entries.reduce((sum, entry) => sum + pick(entry).length, 0);
    if (entries.length > MAX_TRANSLATION_TEXTS || chars(([text]) => text) > MAX_TRANSLATION_CHARS || chars(([, translated]) => translated) > MAX_TRANSLATION_CHARS) {
      throw badRequest('translation_too_long', 'Too much text to translate at once');
    }

    const { hash, cached } = await cachedTranslation(chat.id, messageId, language);
    await keepTranslation(messageId, language, hash, { ...cached, ...corrected });
    return c.json({ texts: corrected });
  });

  /** A message's text as the cache knows it, and what the cache holds for it — nothing where the text has changed since. */
  async function cachedTranslation(
    chatId: string,
    messageId: string,
    language: TranslationLanguage,
  ): Promise<{ hash: string; cached: Record<string, string> }> {
    const [message] = await deps.db
      .select({ content: messages.content })
      .from(messages)
      .where(and(eq(messages.id, messageId), eq(messages.chatId, chatId)));
    if (!message) throw notFound('Message not found');
    const hash = contentHash(message.content);
    const [row] = await deps.db
      .select()
      .from(messageTranslations)
      .where(and(eq(messageTranslations.messageId, messageId), eq(messageTranslations.language, language)));
    return { hash, cached: row && row.contentHash === hash ? row.texts : {} };
  }

  async function keepTranslation(messageId: string, language: TranslationLanguage, hash: string, texts: Record<string, string>) {
    await deps.db
      .insert(messageTranslations)
      .values({ messageId, language, contentHash: hash, texts })
      .onConflictDoUpdate({
        target: [messageTranslations.messageId, messageTranslations.language],
        set: { contentHash: hash, texts, updatedAt: new Date() },
      });
  }

  /**
   * RisuAI's input translation: what the reader wrote, in the work's language,
   * for them to send. Cut by line as RisuAI's `runTranslator` cuts it, with a
   * writing-as prefix kept as written. Nothing is stored — the turn the reader
   * sends is the stored text, in the card's language, as RisuAI stores it.
   */
  app.post('/:id/translate-input', async (c) => {
    const userId = c.get('userId');
    const chat = await loadOwnedChat(deps, requireUuidParam(c), userId);
    const text = requireString(await readJsonBody(c), 'text');
    if (text.length > MAX_INPUT_TRANSLATION_CHARS) {
      throw badRequest('translation_too_long', 'Too much text to translate at once');
    }
    const plot = await loadVisiblePlot(deps.db, chat.plotId, chat.userId);
    const parts = inputParts(text);
    const made = await withTranslationSlot(userId, () => translateTexts(deps, chat, partTexts(parts), plot.language));
    return c.json({ text: applyParts(parts, made) });
  });

  return app;
}

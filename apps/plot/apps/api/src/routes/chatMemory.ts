/**
 * The chat's memory as the reader reads and tends it — RisuAI's HypaV3 summary
 * list (ARCHITECTURE §7.3, §10): every summary with the messages it covers, and
 * a pin, an edit, a delete and a regenerate for each; and the facts of the
 * summaries on the current branch (`facts.ts`), each to edit or delete — and
 * the ones a later summary ended, to restore.
 *
 * Only the chat's owner, as every chat route. A regenerate writes nothing — it
 * answers a new text for the reader to keep or throw away, as RisuAI's reroll
 * does, and keeping it is the edit. Neither the edits nor the deletes touch
 * `memory_revision`: that counter guards a summary being written against the
 * messages changing under it, and a summary written meanwhile still covers what
 * it says. A deleted summary's messages are summarized again by the next
 * refresh, as a gap.
 */
import { DEFAULT_USER_NAME, MAX_FACT_LENGTH, refusalKind, stripImageMacros } from '@shizue/core';
import {
  chatSummaries,
  chatSummaryChunks,
  memories,
  messages,
  personas,
  type Chat,
  type ChatSummary,
  type Message,
} from '@shizue/db';
import { and, asc, eq, inArray } from 'drizzle-orm';
import { Hono } from 'hono';
import type { AppDeps, AppEnv } from '../deps.js';
import { ApiError, badRequest, notFound } from '../errors.js';
import { branchFacts, keepEndedFacts, toFactJson } from '../facts.js';
import { loadMembers } from '../hub.js';
import {
  applicableSummaries,
  loadSummaries,
  MAX_SUMMARY_LENGTH,
  memoryChannel,
  memorySettingsOf,
  scheduleMemoryUpdate,
  summarize,
} from '../memory.js';
import { asSent, loadSentView } from '../sentHistory.js';
import { buildPath } from '../tree.js';
import { optionalBoolean, optionalString, readJsonBody, requireUuidParam } from '../util.js';
import { loadOwnedChat, loadWritableChat } from './chats.js';

/** How much of a covered message the list shows. */
const PREVIEW_LENGTH = 120;

interface CoveredMessage {
  id: string;
  role: Message['role'];
  preview: string;
  /** Its index on the chat's current branch (0: the greeting), or null where it is on another. */
  position: number | null;
}

const preview = (content: string): string => {
  const flat = stripImageMacros(content).replace(/\s+/g, ' ').trim();
  return flat.length > PREVIEW_LENGTH ? `${flat.slice(0, PREVIEW_LENGTH)}…` : flat;
};

function toSummaryJson(summary: ChatSummary, applies: boolean, covered: Map<string, CoveredMessage>) {
  return {
    id: summary.id,
    text: summary.text,
    important: summary.important,
    /** Whether it applies to the current branch: every message it covers is on it. */
    applies,
    messageIds: summary.messageIds,
    /** The covered messages that still exist, in the summary's order. */
    messages: summary.messageIds.flatMap((id) => {
      const message = covered.get(id);
      return message ? [message] : [];
    }),
    createdAt: summary.createdAt.toISOString(),
    updatedAt: summary.updatedAt.toISOString(),
  };
}

/**
 * The chat's summaries as the list shows them — the ones on the branch in its
 * order, then the rest as made — and the facts of the ones on the branch.
 */
async function listMemory(deps: AppDeps, chat: Chat) {
  const all = await deps.db.select().from(messages).where(eq(messages.chatId, chat.id)).orderBy(asc(messages.createdAt));
  const path = buildPath(all, chat.headMessageId);
  const positions = new Map(path.map((message, at) => [message.id, at]));
  const covered = new Map(
    all.map((message) => [
      message.id,
      { id: message.id, role: message.role, preview: preview(message.content), position: positions.get(message.id) ?? null },
    ]),
  );
  const summaries = await loadSummaries(deps.db, chat.id);
  const { applicable } = applicableSummaries(summaries, path);
  const on = new Set(applicable);
  return {
    summaries: [
      ...applicable.map((summary) => toSummaryJson(summary, true, covered)),
      ...summaries.filter((summary) => !on.has(summary)).map((summary) => toSummaryJson(summary, false, covered)),
    ],
    facts: await branchFacts(deps, applicable, await loadMembers(deps.db, chat.plotId)),
  };
}

async function loadChatSummary(deps: AppDeps, chatId: string, summaryId: string): Promise<ChatSummary> {
  const [summary] = await deps.db
    .select()
    .from(chatSummaries)
    .where(and(eq(chatSummaries.id, summaryId), eq(chatSummaries.chatId, chatId)))
    .limit(1);
  if (!summary) throw notFound();
  return summary;
}

export function chatMemoryRoutes(deps: AppDeps): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  app.get('/:id/memory', async (c) => {
    const chat = await loadOwnedChat(deps, requireUuidParam(c), c.get('userId'));
    return c.json(await listMemory(deps, chat));
  });

  // `{content?, invalidated?}`: the reader's rewrite of a fact — its vector goes
  // with the old words, and the refresh it schedules embeds the new ones — or,
  // with `invalidated: false`, the restore of one a later summary ended: it
  // holds again everywhere, and the fact that took its place stays as it is.
  app.patch('/:id/memory/facts/:factId', async (c) => {
    const chat = await loadWritableChat(deps, requireUuidParam(c), c.get('userId'));
    const factId = requireUuidParam(c, 'factId');
    const body = await readJsonBody(c);
    const raw = optionalString(body, 'content');
    const invalidated = optionalBoolean(body, 'invalidated');
    if (raw === undefined && invalidated === undefined) throw badRequest('invalid_request', 'Send content or invalidated');
    if (invalidated === true) throw badRequest('invalid_request', 'A fact is ended by the memory, not by hand');
    const content = raw?.replace(/\s+/g, ' ').trim();
    if (content !== undefined && (content.length === 0 || content.length > MAX_FACT_LENGTH || content.includes('\u0000'))) {
      throw badRequest('invalid_request', `content must be 1-${MAX_FACT_LENGTH} characters, without U+0000`);
    }
    const [fact] = await deps.db
      .update(memories)
      .set({
        ...(content !== undefined ? { content, model: null, embedding: null } : {}),
        ...(invalidated === false ? { invalidatedBySummaryId: null, invalidatedTurn: null, supersededById: null } : {}),
        updatedAt: new Date(),
      })
      .where(and(eq(memories.id, factId), eq(memories.chatId, chat.id)))
      .returning();
    if (!fact) throw notFound();
    if (content !== undefined) scheduleMemoryUpdate(deps, chat.id);
    const listed = (await listMemory(deps, chat)).facts.find((item) => item.id === fact.id);
    return c.json({ fact: listed ?? toFactJson(fact, new Set(), null, await loadMembers(deps.db, chat.plotId)) });
  });

  app.delete('/:id/memory/facts/:factId', async (c) => {
    const chat = await loadWritableChat(deps, requireUuidParam(c), c.get('userId'));
    const deleted = await deps.db
      .delete(memories)
      .where(and(eq(memories.id, requireUuidParam(c, 'factId')), eq(memories.chatId, chat.id)))
      .returning({ id: memories.id });
    if (deleted.length === 0) throw notFound();
    return c.body(null, 204);
  });

  // `{text?, important?}`: the reader's rewrite, or the pin. A rewrite drops the
  // summary's vectors, which the refresh it schedules embeds again.
  app.patch('/:id/memory/:summaryId', async (c) => {
    const chat = await loadWritableChat(deps, requireUuidParam(c), c.get('userId'));
    const summaryId = requireUuidParam(c, 'summaryId');
    const body = await readJsonBody(c);
    const important = optionalBoolean(body, 'important');
    const raw = optionalString(body, 'text');
    const text = raw?.trim();
    if (text === undefined && important === undefined) {
      throw badRequest('invalid_request', 'Send text or important');
    }
    if (text !== undefined && (text.length === 0 || text.length > MAX_SUMMARY_LENGTH || text.includes('\u0000'))) {
      throw badRequest('invalid_request', `text must be 1-${MAX_SUMMARY_LENGTH} characters, without U+0000`);
    }

    const rewritten = await deps.db.transaction(async (tx) => {
      const [current] = await tx
        .select()
        .from(chatSummaries)
        .where(and(eq(chatSummaries.id, summaryId), eq(chatSummaries.chatId, chat.id)))
        .for('update');
      if (!current) throw notFound();
      const changed = text !== undefined && text !== current.text;
      await tx
        .update(chatSummaries)
        .set({
          ...(changed ? { text } : {}),
          ...(important !== undefined ? { important } : {}),
          updatedAt: new Date(),
        })
        .where(eq(chatSummaries.id, summaryId));
      if (changed) await tx.delete(chatSummaryChunks).where(eq(chatSummaryChunks.summaryId, summaryId));
      return changed;
    });
    if (rewritten) scheduleMemoryUpdate(deps, chat.id);
    const summary = (await listMemory(deps, chat)).summaries.find((item) => item.id === summaryId);
    return c.json({ summary });
  });

  // A fact of the summary that a later summary ended moves to that one rather
  // than going with it (`keepEndedFacts`), as on an edit.
  app.delete('/:id/memory/:summaryId', async (c) => {
    const chat = await loadWritableChat(deps, requireUuidParam(c), c.get('userId'));
    const summaryId = requireUuidParam(c, 'summaryId');
    const deleted = await deps.db.transaction(async (tx) => {
      const [summary] = await tx
        .select({ id: chatSummaries.id })
        .from(chatSummaries)
        .where(and(eq(chatSummaries.id, summaryId), eq(chatSummaries.chatId, chat.id)))
        .for('update');
      if (!summary) return false;
      await keepEndedFacts(tx, [summaryId]);
      await tx.delete(chatSummaries).where(eq(chatSummaries.id, summaryId));
      return true;
    });
    if (!deleted) throw notFound();
    return c.body(null, 204);
  });

  // A new text for the summary from the messages it covers, on the chat's
  // auxiliary model — not stored: the reader keeps it with the edit above.
  app.post('/:id/memory/:summaryId/regenerate', async (c) => {
    const chat = await loadOwnedChat(deps, requireUuidParam(c), c.get('userId'));
    const summary = await loadChatSummary(deps, chat.id, requireUuidParam(c, 'summaryId'));
    const settings = memorySettingsOf(chat);
    const rows = await deps.db
      .select()
      .from(messages)
      .where(and(eq(messages.chatId, chat.id), inArray(messages.id, summary.messageIds)));
    const byId = new Map(rows.map((message) => [message.id, message]));
    // What the background summary is made from: what a model reads, the
    // reader's turns left out where the chat says so.
    const source = summary.messageIds
      .map((id) => byId.get(id))
      .filter((message): message is Message => message !== undefined)
      .filter((message) => !message.hiddenFromPrompt && message.content.trim().length > 0)
      .filter((message) => !settings.doNotSummarizeUserMessage || message.role !== 'user');
    if (source.length === 0) throw badRequest('invalid_state', 'Nothing this summary covers is left to summarize');
    if (!(await memoryChannel(deps, chat))) {
      throw new ApiError(503, 'memory_unavailable', 'No model is available to summarize with');
    }

    const [persona] = chat.personaId
      ? await deps.db.select({ name: personas.name }).from(personas).where(eq(personas.id, chat.personaId)).limit(1)
      : [];
    // As the prompt sends them where they stand on the chat's branch (`sentHistory.ts`),
    // as the background summary reads them; a summary of another branch's reads them as stored.
    const all = await deps.db.select().from(messages).where(eq(messages.chatId, chat.id)).orderBy(asc(messages.createdAt));
    const path = buildPath(all, chat.headMessageId);
    const sent = await asSent(() => loadSentView(deps, chat, path, all), path, source);
    let text: string | null;
    try {
      text = await summarize(deps, chat, {
        messages: sent,
        userName: persona?.name ?? DEFAULT_USER_NAME,
        prompt: settings.summarizationPrompt,
      });
    } catch (error) {
      console.error('[memory] regenerating a summary failed', error);
      text = null;
    }
    // A refusal is not a summary to offer for keeping (core `refusalKind`, §7.3).
    const refused = text ? refusalKind(text) : null;
    if (refused) console.warn(`[memory] chat ${chat.id}: the summarizer refused a summary's regeneration (${refused})`);
    if (!text || refused) throw new ApiError(502, 'memory_failed', 'The model did not return a summary');
    return c.json({ text });
  });

  return app;
}

/**
 * A work's chats written out as RisuAI writes a character's (`exportChat`,
 * `exportAllChats` in RisuAI's `src/ts/characters.ts`, ARCHITECTURE §9.1): one
 * chat as JSON (`risuChat` v2, which RisuAI and this app's chat import read
 * back), as text or as an HTML page, and every chat of a work as one JSON file
 * (`risuAllChats` v2). Beside the app's own export (`GET /api/chats/:id/export`,
 * docs/PLATFORM.md), which these leave as it is.
 */
import {
  computeVariables,
  DEFAULT_USER_NAME,
  risuAllChatsFile,
  risuChatFile,
  risuChatHtml,
  risuChatOf,
  risuChatText,
  risuExportFileName,
  type RisuChat,
  type RisuTranscriptNames,
} from '@shizue/core';
import { chats, plots, type Chat } from '@shizue/db';
import { and, asc, eq } from 'drizzle-orm';
import { Hono } from 'hono';
import type { AppDeps, AppEnv } from '../deps.js';
import { badRequest } from '../errors.js';
import { loadMembers } from '../hub.js';
import { loadOwnedPlot } from '../plots.js';
import { localLoreOf } from '../scriptState.js';
import { buildPath } from '../tree.js';
import { attachmentDisposition, isUuid, requireUuidParam } from '../util.js';
import { loadMessages, loadOwnedChat, loadPersona } from './chats.js';

const FORMATS = ['json', 'txt', 'html'] as const;
type Format = (typeof FORMATS)[number];

const CONTENT_TYPES: Record<Format, string> = {
  json: 'application/json; charset=utf-8',
  txt: 'text/plain; charset=utf-8',
  html: 'text/html; charset=utf-8',
};

/**
 * One chat as RisuAI keeps it, and the names its text and HTML are written
 * under. The branch the chat is on is the conversation — RisuAI keeps no other.
 * Where it opens on one of the chat's openings (a parent-null reply, numbered
 * among them as the prompt numbers the greeting, `promptBranch`), that is
 * RisuAI's greeting: left out of the messages and named by `fmIndex`, its text
 * heading the text and HTML — unless the chat came in from a file whose first
 * message is its own (`importedFrom.withoutOpening`). The variables are what the chat's scripts left
 * (`variable_delta`), not what its messages' macros fold to: the macros travel
 * in the messages, and RisuAI runs them again there (`runCurrentChatFunction`),
 * as this app's fold does after an import.
 */
async function risuChatExport(
  deps: AppDeps,
  chat: Chat,
  userId: string,
): Promise<{ chat: RisuChat; names: RisuTranscriptNames }> {
  const [plot] = await deps.db
    .select()
    .from(plots)
    .where(and(eq(plots.id, chat.plotId), eq(plots.ownerId, userId)))
    .limit(1);
  const members = plot ? await loadMembers(deps.db, plot.id) : [];
  const memberNames = new Map(members.map((member) => [member.id, member.name]));
  const persona = await loadPersona(deps, chat);
  const all = await loadMessages(deps, chat.id);
  const path = buildPath(all, chat.headMessageId);
  const openings = all.filter((message) => message.parentId === null && message.role === 'assistant');
  const root = path[0];
  const opened = root !== undefined && openings.includes(root) && !chat.importedFrom?.withoutOpening;
  const conversation = opened ? path.slice(1) : path;
  const char = members.length === 1 ? members[0]!.name : (plot?.name ?? chat.title);
  return {
    chat: risuChatOf({
      id: chat.id,
      name: chat.title,
      note: chat.note,
      fmIndex: opened ? openings.indexOf(root) - 1 : -1,
      messages: conversation.map((message) => ({
        id: message.id,
        role: message.role === 'user' ? 'user' : 'assistant',
        content: message.content,
        createdAt: message.createdAt,
        ...(message.speakerMemberId !== null && memberNames.has(message.speakerMemberId)
          ? { speaker: { id: message.speakerMemberId, name: memberNames.get(message.speakerMemberId)! } }
          : {}),
        ...(message.hiddenFromPrompt ? { hidden: true } : {}),
      })),
      localLore: localLoreOf(chat),
      variables: computeVariables(path.map((message) => ({ content: '', variableDelta: message.variableDelta }))),
      lastDate: chat.updatedAt,
    }),
    names: {
      char,
      user: persona?.name ?? DEFAULT_USER_NAME,
      group: members.length >= 2,
      ...(opened ? { greeting: root.content } : {}),
    },
  };
}

function readFormat(value: string | undefined): Format {
  if (value === undefined) return 'json';
  if (!(FORMATS as readonly string[]).includes(value)) throw badRequest('invalid_request', 'format must be json, txt or html');
  return value as Format;
}

export function risuChatRoutes(deps: AppDeps): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  /**
   * `GET /api/chats/export/risu?plotId=` — every chat of the work, as RisuAI's
   * export of all a character's chats, oldest first. A chat an import is still
   * filling is left out.
   */
  app.get('/export/risu', async (c) => {
    const userId = c.get('userId');
    const plotId = c.req.query('plotId') ?? '';
    if (!isUuid(plotId)) throw badRequest('invalid_request', 'plotId must be a uuid');
    const plot = await loadOwnedPlot(deps, plotId, userId);
    const rows = await deps.db
      .select()
      .from(chats)
      .where(and(eq(chats.userId, userId), eq(chats.plotId, plotId), eq(chats.importing, false)))
      .orderBy(asc(chats.createdAt));
    const written: RisuChat[] = [];
    for (const row of rows) written.push((await risuChatExport(deps, row, userId)).chat);
    const members = await loadMembers(deps.db, plot.id);
    const name = members.length === 1 ? members[0]!.name : plot.name;
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    return c.body(JSON.stringify(risuAllChatsFile(written)), 200, {
      'content-type': CONTENT_TYPES.json,
      'content-disposition': attachmentDisposition(risuExportFileName(`${name}_all_chats_${stamp}`, 'json')),
    });
  });

  /** `GET /api/chats/:id/export/risu?format=json|txt|html` — one chat, as RisuAI's export writes it. */
  app.get('/:id/export/risu', async (c) => {
    const userId = c.get('userId');
    const format = readFormat(c.req.query('format'));
    const chat = await loadOwnedChat(deps, requireUuidParam(c), userId);
    const exported = await risuChatExport(deps, chat, userId);
    const body =
      format === 'json'
        ? JSON.stringify(risuChatFile(exported.chat))
        : format === 'txt'
          ? risuChatText(exported.chat, exported.names)
          : risuChatHtml(exported.chat, exported.names);
    return c.body(body, 200, {
      'content-type': CONTENT_TYPES[format],
      'content-disposition': attachmentDisposition(
        risuExportFileName(`${exported.names.char}_${new Date().toJSON()}_chat`, format),
      ),
    });
  });

  return app;
}

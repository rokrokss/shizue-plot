/**
 * What RisuAI's `sendChat` reads for a request that the assembler cannot read
 * by itself (ARCHITECTURE §6 프롬프트 조립): its checks on the model, the
 * pictures a turn's `{{asset_prompt::name}}` attaches, and the Additional Text
 * a card keeps beside its description (`additionalInformations`).
 */
import { createHash } from 'node:crypto';
import {
  assetPromptNames,
  characterName,
  type HistoryMessage,
  type PromptCharacter,
} from '@shizue/core';
import { characters, plotAssets, type ContentLanguage } from '@shizue/db';
import { and, eq } from 'drizzle-orm';
import { MAX_INLINE_IMAGE_BYTES } from './attachments.js';
import type { AppDeps } from './deps.js';
import { embedErrorForLog } from './embedder.js';
import { readAll } from './storage.js';

/**
 * What RisuAI's checks on its model id say of a request format
 * (`AssemblePromptInput.modelKind`): `gpt` for its gpt, claude, openrouter and
 * reverse_proxy models — an OpenAI or Anthropic format here, the ChatGPT plan's
 * and a local server's OpenAI-compatible one among them — and `novelai`.
 */
export function modelKindOf(format: string): 'gpt' | 'novelai' | undefined {
  if (format.startsWith('openai') || format.startsWith('anthropic')) return 'gpt';
  if (format === 'novelai') return 'novelai';
  return undefined;
}

/**
 * The pictures the history's `{{asset_prompt::name}}` macros name, as data
 * URLs, by name: the work's picture of that name — RisuAI looks in the
 * character's and the modules' assets, which are the work's here — or, for
 * `icon` where no picture is called that, the asked member's avatar. Read up
 * to what a turn's pictures may add to a request (`MAX_INLINE_IMAGE_BYTES`);
 * a name with no picture, or past that, attaches nothing.
 */
export async function assetPromptImages(
  deps: AppDeps,
  plotId: string,
  history: readonly HistoryMessage[],
  asked: Pick<PromptCharacter, 'id'> | undefined,
): Promise<Map<string, string>> {
  const images = new Map<string, string>();
  const names = new Set(history.flatMap((turn) => (turn.hidden ? [] : assetPromptNames(turn.promptContent ?? turn.content))));
  if (names.size === 0) return images;
  const rows = await deps.db
    .select({ name: plotAssets.name, slug: plotAssets.slug, path: plotAssets.path, mime: plotAssets.mime })
    .from(plotAssets)
    .where(eq(plotAssets.plotId, plotId));
  const byName = new Map(rows.map((row) => [row.name ?? row.slug, row] as const));
  let budget = MAX_INLINE_IMAGE_BYTES;
  const read = async (path: string, mime: string): Promise<string | null> => {
    const object = await deps.storage.get(path);
    if (!object) return null;
    const encoded = Math.ceil(object.size / 3) * 4;
    if (encoded > budget) {
      await object.body.cancel();
      return null;
    }
    budget -= encoded;
    return `data:${mime};base64,${(await readAll(object.body)).toString('base64')}`;
  };
  for (const name of names) {
    const asset = byName.get(name);
    if (asset) {
      const url = await read(asset.path, asset.mime);
      if (url) images.set(name, url);
    } else if (name === 'icon' && asked?.id) {
      const [member] = await deps.db
        .select({ avatarPath: characters.avatarPath })
        .from(characters)
        .where(and(eq(characters.id, asked.id), eq(characters.plotId, plotId)))
        .limit(1);
      const path = member?.avatarPath;
      const url = path ? await read(path, mimeOfPath(path)) : null;
      if (url) images.set(name, url);
    }
  }
  return images;
}

const mimeOfPath = (path: string): string => {
  const ext = path.slice(path.lastIndexOf('.') + 1).toLowerCase();
  return ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg' : ext === 'webp' ? 'image/webp' : ext === 'gif' ? 'image/gif' : 'image/png';
};

/** How long the Additional Text search may take before the request goes without it. */
const ADDITIONAL_TEXT_TIMEOUT_MS = 3_000;
/** Searches kept, by the card's text and the chat's opening: past the fourth message the search never changes. */
const ADDITIONAL_TEXT_CACHE = 64;
const additionalTextCache = new Map<string, string>();

/** A card's Additional Text (`extensions.risuai.additionalText`), or ''. */
export function additionalTextOfCard(member: Pick<PromptCharacter, 'card'>): string {
  const risu = member.card.extensions?.['risuai'];
  const text = typeof risu === 'object' && risu !== null ? (risu as Record<string, unknown>)['additionalText'] : undefined;
  return typeof text === 'string' ? text : '';
}

/**
 * RisuAI's Additional Text retrieval (`additionalInformations` in its
 * `embedding/addinfo.ts`) for the character a request is for: the card's
 * Additional Text cut on blank lines, searched by meaning with the chat's first
 * four messages after the greeting — each `name: text` — and its three closest
 * chunks, joined by blank lines, which the description is sent with. On the
 * server's embedder, with the work's model; where it cannot run — off, not yet
 * downloaded, past its time — nothing is added. '' for a card without any.
 */
export async function additionalTextFor(
  deps: AppDeps,
  input: {
    member: PromptCharacter;
    /** The branch's messages after its greeting, oldest first. */
    messages: readonly { role: 'user' | 'assistant'; content: string }[];
    userName: string;
    plotLanguage: ContentLanguage | undefined;
  },
): Promise<string> {
  const text = additionalTextOfCard(input.member);
  if (!text.trim()) return '';
  const chunks = text.split('\n\n').filter((chunk) => chunk.trim().length > 0);
  if (chunks.length === 0) return '';
  const embedder = deps.embedder;
  const language = input.plotLanguage;
  const model = embedder && language ? embedder.modelFor(language) : null;
  if (!embedder || !language || !model) return '';
  const name = characterName(input.member);
  const query = input.messages
    .slice(0, 4)
    .map((message) => `${message.role === 'user' ? input.userName : name}: ${message.content}`)
    .join('\n\n');
  const key = createHash('sha256').update(JSON.stringify([model, text, query])).digest('hex');
  const cached = additionalTextCache.get(key);
  if (cached !== undefined) return cached;
  try {
    const [documents, asked] = await Promise.all([
      embedder.embed(chunks, { plotLanguage: language, kind: 'document', timeoutMs: ADDITIONAL_TEXT_TIMEOUT_MS }),
      embedder.embed([query], { plotLanguage: language, kind: 'query', timeoutMs: ADDITIONAL_TEXT_TIMEOUT_MS }),
    ]);
    const target = asked.vectors[0];
    if (documents.model !== model || asked.model !== model || !target) return '';
    const ranked = chunks
      .map((chunk, at) => ({ chunk, score: cosine(documents.vectors[at] ?? [], target) }))
      .sort((a, b) => b.score - a.score);
    const found = ranked
      .slice(0, 3)
      .map((entry) => entry.chunk)
      .join('\n\n');
    if (additionalTextCache.size >= ADDITIONAL_TEXT_CACHE) additionalTextCache.delete(additionalTextCache.keys().next().value!);
    additionalTextCache.set(key, found);
    return found;
  } catch (error) {
    console.warn('[prompt] the Additional Text search failed; the description goes without it', embedErrorForLog(error));
    return '';
  }
}

function cosine(a: readonly number[], b: readonly number[]): number {
  let dot = 0;
  let left = 0;
  let right = 0;
  for (let at = 0; at < Math.min(a.length, b.length); at += 1) {
    dot += a[at]! * b[at]!;
    left += a[at]! * a[at]!;
    right += b[at]! * b[at]!;
  }
  return left > 0 && right > 0 ? dot / Math.sqrt(left * right) : 0;
}

/**
 * The roster with RisuAI's Additional Text on the member the request is for
 * (`additionalTextFor`): a group turn's speaker, or the one member of a work of
 * one — RisuAI's `currentChar`. A scene of several, which RisuAI has no request
 * for, goes without.
 */
export async function withAdditionalText(
  deps: AppDeps,
  roster: PromptCharacter[],
  input: {
    speaker: number | undefined;
    messages: readonly { role: 'user' | 'assistant'; content: string }[];
    userName: string;
    plotLanguage: ContentLanguage | undefined;
  },
): Promise<PromptCharacter[]> {
  const at = input.speaker ?? (roster.length === 1 ? 0 : -1);
  const member = roster[at];
  if (!member || member.absent || !additionalTextOfCard(member).trim()) return roster;
  const additionalText = await additionalTextFor(deps, { ...input, member });
  if (!additionalText) return roster;
  return roster.map((one, index) => (index === at ? { ...one, additionalText } : one));
}

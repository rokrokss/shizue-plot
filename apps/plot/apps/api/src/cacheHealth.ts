/**
 * How much of each prompt the provider served from its prompt cache, as its
 * usage reports it (the Responses API's `input_tokens_details.cached_tokens`,
 * which the ChatGPT adapter reads into `cachedPromptTokens`), and for a chat's
 * reply why it was not served what it could have been: a line per chat request,
 * and every `EVERY` requests of a site the share over them, with a chat's misses
 * by reason, as `lexicalHealth.ts` reports its searches. A provider path that
 * reports nothing — the echo model, a test stub — counts as unreported, so the
 * log says there is nothing to learn rather than showing 0%. Per process, and
 * forgotten once said. Logging, and the token counts of the metrics
 * (`metrics.ts`): nothing reads it back, and nothing is written to the database.
 *
 * What a chat request could have been served (ARCHITECTURE §7.3 프롬프트 캐시
 * 측정): this backend keeps a request up to the end of its newest user message
 * and serves it to a later request of the same key that begins with all of it,
 * byte for byte — so the request before it in the chat, up to there, unless
 * something before that point changed. Each request leaves a fingerprint — hashes
 * of the system string's parts and of each message up to its newest user turn,
 * with what each is — and the next request of the chat is compared with it. When
 * the share served falls under half of what that earlier request would give
 * (`MISS_SHARE`), the first difference upstream names the reason (`MissReason`).
 */
import {
  countTokens,
  fnv1a,
  IMAGE_TOKEN_ESTIMATE,
  promptText,
  type AssembledPrompt,
  type PromptBlockKind,
  type PromptMessage,
} from '@shizue/core';
import { cachedPromptTokens, promptTokens } from './metrics.js';

export type CacheSite = 'chat' | 'side';

/**
 * Why a chat request missed what the one before it would have served, the
 * first that holds, cause before symptom:
 *
 * - `first` — this process has no earlier request of the chat (a restart, its
 *   first turn, or one forgotten past `MAX_CHATS`).
 * - `edited_or_regenerated` — the earlier request's newest user turn is not in
 *   this one as it was (an edit or delete of it, a branch switch), an edit
 *   dropped a summary (the history starts earlier), or a turn before it differs.
 * - `summary_landed` — a summary landed: the history starts later and the
 *   summary block changed.
 * - `system_changed:lore` — the lore the system string keeps differs: an
 *   always-on entry's macros read differently, a keyword entry the card's own
 *   `@@position` placed came or went, or a keyword entry took budget an
 *   always-on one had. Keyword lore otherwise goes after the newest turn
 *   (`moved_lore`), outside what the next request repeats.
 * - `system_changed:clock` — the summary block differs with the memory's clock
 *   (`MemoryInput.clock`) and nothing landed.
 * - `system_changed:other` — anything else in the system string: the summary
 *   block otherwise (a pin, a summary edited), a macro in the card's text.
 * - `history_shifted` — the budget dropped the oldest turn sent, or the example
 *   dialogue, with nothing landed.
 * - `depth_injection` — the first difference is a depth lore entry, the
 *   author's note or a start trigger's injection among the turns.
 * - `gap_long` — nothing before the earlier request's newest user turn changed,
 *   and it was sent more than `GAP_LONG_MS` before: its cache likely expired.
 * - `unknown` — nothing changed and the gap was short (the backend sometimes
 *   does not serve a request it should), or a request the card's scripts edited,
 *   whose parts are not known.
 */
export type MissReason =
  | 'first'
  | 'edited_or_regenerated'
  | 'summary_landed'
  | 'system_changed:lore'
  | 'system_changed:clock'
  | 'system_changed:other'
  | 'history_shifted'
  | 'depth_injection'
  | 'gap_long'
  | 'unknown';

const EVERY = 100;
/** Chats whose last request is remembered; a fingerprint is a few kilobytes at most. */
const MAX_CHATS = 2_000;
/**
 * A request served under this share of what the one before it would give is a
 * miss. The backend serves a whole earlier request or nothing (§7.3), so a
 * served request comes in near the whole and a missed one near none.
 */
const MISS_SHARE = 0.5;
/** The least the provider caches; a request shorter than this is never served. */
const MIN_CACHED = 1_024;
/**
 * The longest gap this route was measured to still serve a whole prompt after:
 * a 24.5k-token prompt repeated 10, 30 and 60 minutes after its first call was
 * served all of it each time (2026-10-16, ARCHITECTURE §7.3 프롬프트 캐시 측정).
 * Longer gaps are unmeasured, though the response reports a 24-hour
 * `prompt_cache_retention`; every line says the gap for the owner to read.
 */
const GAP_LONG_MS = 60 * 60_000;

interface Tally {
  requests: number;
  /** Requests whose usage said how much was cached, and their tokens. */
  reported: number;
  prompt: number;
  cached: number;
  /** Reported requests with any cached token at all. */
  hits: number;
  /** A chat's misses, by reason. */
  misses: Map<MissReason, number>;
}

const tallies = new Map<CacheSite, Tally>();

const percent = (part: number, whole: number): number => (whole > 0 ? Math.round((100 * part) / whole) : 0);

/** One step of the site's share, said every `EVERY` requests. */
function tally(site: CacheSite, usage: { promptTokens: number; cachedPromptTokens?: number }, miss?: MissReason): void {
  const t = tallies.get(site) ?? { requests: 0, reported: 0, prompt: 0, cached: 0, hits: 0, misses: new Map() };
  t.requests += 1;
  const cached = usage.cachedPromptTokens;
  promptTokens.inc({ site }, usage.promptTokens);
  if (cached !== undefined) {
    cachedPromptTokens.inc({ site }, cached);
    t.reported += 1;
    t.prompt += usage.promptTokens;
    t.cached += cached;
    if (cached > 0) t.hits += 1;
  }
  if (miss) t.misses.set(miss, (t.misses.get(miss) ?? 0) + 1);
  tallies.set(site, t);
  if (t.requests < EVERY) return;
  const misses = [...t.misses].sort((a, b) => b[1] - a[1]).map(([reason, count]) => `${reason} ${count}`);
  console.log(
    t.reported === 0
      ? `[cache] ${site}: none of ${t.requests} requests reported cached tokens`
      : `[cache] ${site}: ${percent(t.cached, t.prompt)}% of ${t.prompt} prompt tokens cached over ${t.reported} reporting requests ` +
          `(${t.hits} with any; ${t.requests - t.reported} of ${t.requests} reported nothing)` +
          (misses.length > 0 ? `; misses: ${misses.join(', ')}` : ''),
  );
  tallies.delete(site);
}

/** A side call's share (the summarizer and the rest): counted, never compared. */
export function noteCachedTokens(site: CacheSite, usage: { promptTokens: number; cachedPromptTokens?: number }): void {
  tally(site, usage);
}

/* ------------------------------------------------------------ fingerprints */

/** What a message is, as far as the reasons go. */
const enum Kind {
  Other = 0,
  History = 1,
  /** A depth lore entry, the author's note, a start trigger's injection. */
  Depth = 2,
  Examples = 3,
}

const KINDS: Partial<Record<PromptBlockKind, Kind>> = {
  history: Kind.History,
  depth_lore: Kind.Depth,
  author_note: Kind.Depth,
  injection: Kind.Depth,
  examples: Kind.Examples,
};

/** A chat request as the next one is compared with it. */
interface Fingerprint {
  /** When it was sent, ms. */
  at: number;
  /** Hashes of the system string's lore sections, its summary block, and the rest (or the whole, its sections unknown). */
  lore: number;
  memory: number;
  rest: number;
  /** The memory's clock. */
  clock: number;
  /** The first turn after the summaries' frontier, before the budget dropped any (`GenerationPlan.history`). */
  start: string | null;
  /** The first turn sent, past what the budget dropped. */
  sent: string | null;
  /** Each message up to and including the newest user turn: what it is, its stored id's hash, its role and words' hash. */
  kinds: Uint8Array;
  ids: Uint32Array;
  texts: Uint32Array;
  /** The words after the newest user turn, which the next request does not repeat. */
  tail: number;
  /** The prompt tokens the provider counted, once its usage came. */
  prompt?: number;
  /** Whether the messages came with what they are (`AssembledPrompt.sources`): not once the card's scripts edited the request. */
  known: boolean;
}

/** The last request of each chat (and each group member speaking in it), newest last. */
const lastRequests = new Map<string, Fingerprint>();

function contentHash(message: PromptMessage): number {
  const content = message.content;
  const words =
    typeof content === 'string'
      ? content
      : content.map((part) => (part.type === 'text' ? `t\u0000${part.text}` : `i\u0000${part.url}`)).join('\u0001');
  return fnv1a(`${message.role}\u0002${words}`);
}

function fingerprintOf(
  request: AssembledPrompt,
  memory: { clock: number; history: readonly { id?: string }[] },
  at: number,
): Fingerprint {
  const sections = request.systemSections;
  const pick = (test: (kind: PromptBlockKind) => boolean): number =>
    fnv1a(
      (sections ?? [])
        .filter((section) => test(section.kind))
        .map((section) => `${section.kind}\u0000${section.text}`)
        .join('\u0001'),
    );
  const isLore = (kind: PromptBlockKind): boolean => kind === 'lore_before' || kind === 'lore_after';
  const newest = request.messages.findLastIndex((message) => message.role === 'user');
  const upto = newest + 1;
  const sources = request.sources;
  const kinds = new Uint8Array(upto);
  const ids = new Uint32Array(upto);
  const texts = new Uint32Array(upto);
  for (let at = 0; at < upto; at += 1) {
    const source = sources?.[at];
    kinds[at] = (source && KINDS[source.kind]) ?? Kind.Other;
    ids[at] = source?.id !== undefined ? fnv1a(source.id) : 0;
    texts[at] = contentHash(request.messages[at]!);
  }
  const images = (message: PromptMessage): number =>
    typeof message.content === 'string' ? 0 : message.content.filter((part) => part.type === 'image').length;
  const tail = request.messages
    .slice(upto)
    .reduce((sum, message) => sum + countTokens(promptText(message.content)) + images(message) * IMAGE_TOKEN_ESTIMATE, 0);
  const sentAt = sources?.findIndex((source) => source.kind === 'history') ?? -1;
  return {
    at,
    lore: sections ? pick(isLore) : 0,
    memory: sections ? pick((kind) => kind === 'memory') : 0,
    rest: sections ? pick((kind) => !isLore(kind) && kind !== 'memory') : fnv1a(request.system),
    clock: memory.clock,
    start: memory.history[0]?.id ?? null,
    sent: sentAt >= 0 ? (sources![sentAt]!.id ?? null) : null,
    kinds,
    ids,
    texts,
    tail,
    known: sources !== undefined,
  };
}

function remember(lane: string, fingerprint: Fingerprint): void {
  lastRequests.delete(lane);
  lastRequests.set(lane, fingerprint);
  if (lastRequests.size > MAX_CHATS) lastRequests.delete(lastRequests.keys().next().value!);
}

/** Whether message `at` is the same in both. */
const sameAt = (previous: Fingerprint, current: Fingerprint, at: number): boolean =>
  previous.texts[at] === current.texts[at] && previous.ids[at] === current.ids[at] && previous.kinds[at] === current.kinds[at];

/** Whether `current` begins with all of `previous` up to its newest user turn, the system string first. */
function goesOnFrom(previous: Fingerprint, current: Fingerprint): boolean {
  if (previous.lore !== current.lore || previous.memory !== current.memory || previous.rest !== current.rest) return false;
  if (current.texts.length < previous.texts.length) return false;
  for (let at = 0; at < previous.texts.length; at += 1) if (!sameAt(previous, current, at)) return false;
  return true;
}

/** Why `current` does not begin with `previous` up to its newest user turn (`goesOnFrom` is false). */
function breaker(previous: Fingerprint, current: Fingerprint, history: ReadonlySet<string>): MissReason {
  // The earlier request's newest user turn, as it was: the reader went on from it.
  const last = previous.texts.length - 1;
  const wentOn =
    last < 0 ||
    Array.from(current.texts).some((text, at) => text === previous.texts[last] && current.ids[at] === previous.ids[last]);
  if (!wentOn) return 'edited_or_regenerated';
  if (previous.start !== current.start) {
    // A start this history still holds moved back: an edit dropped the summary over it.
    return previous.start !== null && history.has(previous.start) ? 'edited_or_regenerated' : 'summary_landed';
  }
  if (previous.lore !== current.lore) return 'system_changed:lore';
  if (previous.memory !== current.memory && previous.clock !== current.clock) return 'system_changed:clock';
  if (previous.memory !== current.memory || previous.rest !== current.rest) return 'system_changed:other';
  if (previous.sent !== current.sent) return 'history_shifted';
  if (!previous.known || !current.known) return 'unknown';
  const at = Array.from(previous.texts).findIndex((_, index) => !sameAt(previous, current, index));
  // All of it there but cut short: this request is the shorter.
  if (at < 0) return 'edited_or_regenerated';
  const kinds = [previous.kinds[at], current.kinds[at]];
  if (kinds.includes(Kind.Depth)) return 'depth_injection';
  if (kinds.includes(Kind.Examples)) return 'history_shifted';
  if (kinds.includes(Kind.History)) return 'edited_or_regenerated';
  return 'unknown';
}

/**
 * A chat request about to go out: remembers it as its chat's last and answers
 * what to call with the provider's usage once the reply ends, which logs the
 * share served, the gap since the chat's request before, and — when it fell
 * well under what that request would give — why. `lane` is the chat, and the
 * member a group turn asks: a speaker's next round goes on from their own last
 * request (ARCHITECTURE §6 캐시와 자리). `memory` is the plan's memory clock and the history after the
 * summaries' frontier.
 */
export function chatRequestSent(
  lane: { chatId: string; speaker?: number },
  request: AssembledPrompt,
  memory: { clock: number; history: readonly { id?: string }[] },
  now = Date.now(),
): (usage: { promptTokens: number; cachedPromptTokens?: number }) => void {
  const key = lane.speaker === undefined ? lane.chatId : `${lane.chatId}\u0000${lane.speaker}`;
  const previous = lastRequests.get(key);
  const current = fingerprintOf(request, memory, now);
  remember(key, current);
  const history = new Set(memory.history.flatMap((turn) => (turn.id !== undefined ? [turn.id] : [])));
  const label = lane.speaker === undefined ? lane.chatId : `${lane.chatId} (speaker ${lane.speaker})`;

  return (usage) => {
    current.prompt = usage.promptTokens;
    const cached = usage.cachedPromptTokens;
    if (cached === undefined) {
      tally('chat', usage);
      return;
    }
    const share = `${cached} of ${usage.promptTokens} prompt tokens cached (${percent(cached, usage.promptTokens)}%)`;
    let miss: MissReason | undefined;
    let said: string;
    if (!previous) {
      said = 'no earlier request of the chat seen';
      if (usage.promptTokens >= MIN_CACHED && cached < usage.promptTokens * MISS_SHARE) miss = 'first';
    } else {
      const gap = now - previous.at;
      said = `${Math.round(gap / 1000)} s after the chat's request before`;
      // What the earlier request would give: itself up to its newest user turn —
      // its own count where its usage came, else this one's, near enough.
      const due = previous.prompt !== undefined ? previous.prompt - previous.tail : usage.promptTokens - current.tail;
      if (due >= MIN_CACHED && cached < due * MISS_SHARE) {
        if (!goesOnFrom(previous, current)) miss = breaker(previous, current, history);
        else miss = gap > GAP_LONG_MS ? 'gap_long' : 'unknown';
        said += `, ~${due} expected`;
      }
    }
    console.log(`[cache] chat ${label}: ${share}, ${said}${miss ? `; miss: ${miss}` : ''}`);
    tally('chat', usage, miss);
  };
}

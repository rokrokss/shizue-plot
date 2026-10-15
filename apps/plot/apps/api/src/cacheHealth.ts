/**
 * How much of each prompt the provider served from its prompt cache, as its
 * usage reports it (the Responses API's `input_tokens_details.cached_tokens`,
 * which the ChatGPT adapter reads into `cachedPromptTokens`): a line per chat
 * request, and every `EVERY` requests of a site the share over them, as
 * `lexicalHealth.ts` reports its searches. A provider path that reports nothing
 * — the echo model, a test stub — counts as unreported, so the log says there is
 * nothing to learn rather than showing 0%. Per process, and forgotten once said.
 * Logging only: nothing reads it back.
 */
export type CacheSite = 'chat' | 'side';

const EVERY = 100;

interface Tally {
  requests: number;
  /** Requests whose usage said how much was cached, and their tokens. */
  reported: number;
  prompt: number;
  cached: number;
  /** Reported requests with any cached token at all. */
  hits: number;
}

const tallies = new Map<CacheSite, Tally>();

const percent = (part: number, whole: number): number => (whole > 0 ? Math.round((100 * part) / whole) : 0);

export function noteCachedTokens(
  site: CacheSite,
  usage: { promptTokens: number; cachedPromptTokens?: number },
  chatId?: string,
): void {
  const tally = tallies.get(site) ?? { requests: 0, reported: 0, prompt: 0, cached: 0, hits: 0 };
  tally.requests += 1;
  const cached = usage.cachedPromptTokens;
  if (cached !== undefined) {
    tally.reported += 1;
    tally.prompt += usage.promptTokens;
    tally.cached += cached;
    if (cached > 0) tally.hits += 1;
    if (site === 'chat') {
      console.log(
        `[cache] chat ${chatId ?? '?'}: ${cached} of ${usage.promptTokens} prompt tokens cached (${percent(cached, usage.promptTokens)}%)`,
      );
    }
  }
  tallies.set(site, tally);
  if (tally.requests < EVERY) return;
  console.log(
    tally.reported === 0
      ? `[cache] ${site}: none of ${tally.requests} requests reported cached tokens`
      : `[cache] ${site}: ${percent(tally.cached, tally.prompt)}% of ${tally.prompt} prompt tokens cached over ${tally.reported} reporting requests ` +
          `(${tally.hits} with any; ${tally.requests - tally.reported} of ${tally.requests} reported nothing)`,
  );
  tallies.delete(site);
}

/**
 * The reader's Lua sandbox, kept for the tab rather than for one chat page.
 *
 * RisuAI keeps one Lua state a mode for the whole app, made anew only when the
 * code changes, so a script's globals outlive the chat they were set in. Here
 * the states live in the sandbox's worker (`@shizue/core/lua`, one a card's code
 * and mode — `luaCodeKey` — the oldest closed past `LUA_LIMITS.engines`), and
 * the sandbox is this module's, one for the reader: a chat page leases it and
 * gives it back, so moving between the reader's chats — in one work or another
 * with the same card — keeps what the card's scripts left, as long as their code
 * is the same. A group's members, whose code differs, keep theirs apart, where
 * RisuAI's one state would start afresh at every speaker change. Never across
 * readers — a different reader's lease ends it. A reload ends it too, as
 * RisuAI's states are in memory.
 *
 * Giving a lease back never ends the sandbox: another lease may be running in it
 * — the set a page builds when the reader switches a module or a preset takes
 * its own lease before the set it replaces gives its one back, and the next
 * chat's page may have taken one already. A call of the lease still running is
 * let go instead: it answers `killed` (`disposed`) at once to the scripts that
 * made it, which are gone, and what it is waiting on or still asks of the page
 * — a dialog nobody will answer now, a model call — fails, so the call ends in
 * the worker on its own and the state's queue moves on. A call spinning without
 * asking anything is the watchdog's, as ever.
 */
import type { LuaHost, LuaOutcome, LuaSandbox } from './sandbox';

let held: { reader: string; sandbox: LuaSandbox } | null = null;

/** What a call of a lease given back answers its scripts. */
const LET_GO: LuaOutcome = { kind: 'killed', reason: 'disposed' };

/**
 * A page's lease on `reader`'s sandbox, opened by `open` if they have none.
 * Its `dispose` gives the lease back and lets its own calls go; the sandbox,
 * and every other lease's calls, run on.
 */
export function readerLuaSandbox(reader: string, open: () => LuaSandbox): LuaSandbox {
  if (held && held.reader !== reader) endReaderLuaSandbox();
  held ??= { reader, sandbox: open() };
  const mine = held;
  let given = false;
  let giveBack!: () => void;
  const gone = new Promise<void>((resolve) => {
    giveBack = resolve;
  });
  return {
    async call(code, entry, snapshot, host, stateKey): Promise<LuaOutcome> {
      if (held !== mine) return { kind: 'unavailable', message: 'the sandbox was closed for another reader' };
      if (given) return LET_GO;
      return Promise.race([
        mine.sandbox.call(code, entry, snapshot, untilGone(host, gone, () => given), stateKey),
        gone.then(() => LET_GO),
      ]);
    },
    dispose() {
      given = true;
      giveBack();
    },
  };
}

/**
 * `host` for a lease's call: each request answered as `host` answers it, until
 * the lease is given back (`gone`) — then one still open fails, and one asked
 * after fails without reaching the page.
 */
function untilGone(host: LuaHost, gone: Promise<void>, given: () => boolean): LuaHost {
  const failed = gone.then((): never => {
    throw new Error('the page that ran the script is gone');
  });
  // Nothing may be waiting on it when it fails.
  failed.catch(() => undefined);
  const guard =
    <A extends unknown[], R>(request: (...args: A) => Promise<R>) =>
    (...args: A): Promise<R> =>
      given() ? failed : Promise.race([request(...args), failed]);
  return {
    alert: guard((text: string, error: boolean) => host.alert(text, error)),
    input: guard((text: string) => host.input(text)),
    select: guard((options: string[]) => host.select(options)),
    confirm: guard((text: string) => host.confirm(text)),
    llm: guard((messages: Parameters<LuaHost['llm']>[0], model: Parameters<LuaHost['llm']>[1]) => host.llm(messages, model)),
    similarity: guard((source: string, texts: string[]) => host.similarity(source, texts)),
    request: guard((url: string | null) => host.request(url)),
    lore: guard((history: string[], upserts: Parameters<LuaHost['lore']>[1]) => host.lore(history, upserts)),
  };
}

/** Ends the reader's sandbox, and every state in it: for another reader. */
export function endReaderLuaSandbox(): void {
  const was = held;
  held = null;
  was?.sandbox.dispose();
}

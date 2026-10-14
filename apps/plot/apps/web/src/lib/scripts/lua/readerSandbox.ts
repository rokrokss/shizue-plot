/**
 * The reader's Lua sandbox, kept for the tab rather than for one chat page.
 *
 * RisuAI keeps one Lua state a mode for the whole app, made anew only when the
 * code changes, so a script's globals outlive the chat they were set in. Here
 * the states live in the sandbox's worker (`@shizue/core/lua`, one a member and
 * mode, the oldest closed past `LUA_LIMITS.engines`), and the sandbox is this
 * module's, one for the reader: a chat page leases it and gives it back, so
 * moving between the reader's chats keeps what a member's scripts left, as long
 * as their code is the same. Never across readers — a different reader's lease
 * ends it, and so does signing out (`authClient.ts`). A reload ends it too, as
 * RisuAI's states are in memory.
 *
 * A page that goes with a call still running ends it as it always did: that
 * call may wait on a dialog nobody will answer now, which would hold the
 * state's queue for good. The next call starts a fresh worker.
 *
 * Imports no more than types, so the session code that ends it carries none of
 * the sandbox.
 */
import type { LuaOutcome, LuaSandbox } from './sandbox';

let held: { reader: string; sandbox: LuaSandbox } | null = null;

/**
 * A page's lease on `reader`'s sandbox, opened by `open` if they have none.
 * Its `dispose` gives the lease back, ending the sandbox only while one of its
 * calls is still running.
 */
export function readerLuaSandbox(reader: string, open: () => LuaSandbox): LuaSandbox {
  if (held && held.reader !== reader) endReaderLuaSandbox();
  held ??= { reader, sandbox: open() };
  const mine = held;
  let running = 0;
  return {
    async call(...args: Parameters<LuaSandbox['call']>): Promise<LuaOutcome> {
      if (held !== mine) return { kind: 'unavailable', message: 'the sandbox was closed for another reader' };
      running += 1;
      try {
        return await mine.sandbox.call(...args);
      } finally {
        running -= 1;
      }
    },
    dispose() {
      if (running > 0) mine.sandbox.dispose();
    },
  };
}

/** Ends the reader's sandbox, and every state in it: on signing out, or another reader. */
export function endReaderLuaSandbox(): void {
  const was = held;
  held = null;
  was?.sandbox.dispose();
}

import type { PhoneAccess } from './tunnel.js';
import type { Db } from '@shizue/db';
import type { getAdapter } from '@shizue/llm';
import type { ChatGPTAccounts } from './chatgptAccounts.js';
import type { Embedder } from './embedder.js';
import type { RemoteFetch } from './localizeAssets.js';
import type { LuaStateStore, RequestLuaRunner } from './requestLua.js';
import type { RequestTriggerRunner } from './requestTriggers.js';
import type { ScriptFetch } from './scriptFetch.js';
import type { ObjectStorage } from './storage.js';

/** The db handle inside a transaction — same query surface as `Db`. */
export type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

/** The fire-and-forget jobs a finished turn — or a plot's write — can start. */
export type BackgroundTaskKind = 'memory' | 'emotion' | 'vectors' | 'aliases';

/** A generation stream this process has open (`AppDeps.generationStreams`). */
export interface OpenGeneration {
  /** The chat it answers, which the reader's stop names (`stopChatGeneration`). */
  chatId: string;
  /** Stops it: what arrived is kept as a stopped reply. A disconnect does not — the reply goes on. */
  stop: () => void;
  /** Settles once its reply is stored and its chat's slot given back. */
  settled: Promise<void>;
}

export interface AppDeps {
  db: Db;
  /** The web app's origin, which every write must come from; tests may mount without it. */
  webOrigin?: string;
  /** Other origins the web app is reached at (`REMOTE_ORIGINS`), trusted as `webOrigin` is. */
  remoteOrigins?: string[];
  /**
   * The tunnel a phone opens this machine's shizue through, from the settings
   * page (`tunnel.ts`). Only when the web origin is a loopback one (`index.ts`);
   * without it `/api/devices` answers 404.
   */
  phoneAccess?: PhoneAccess;
  /** The owner's ChatGPT connection (§4.1); absent in tests that do not connect one. */
  chatgpt?: { accounts: ChatGPTAccounts };
  /** Avatars, plot assets and chat attachments; the local driver by default. */
  storage: ObjectStorage;
  /** Environment used for LLM provider gating. */
  env: NodeJS.ProcessEnv;
  /**
   * Chat ids a generation is running on — one at a time per chat. In memory
   * only: the app is one process, so a restart frees every chat.
   */
  generating: Set<string>;
  /** The generation streams this process has open, for the reader's stop and shutdown (`stopChatGeneration`, `stopGenerations`). */
  generationStreams: Set<OpenGeneration>;
  /** Chat ids with a memory refresh in flight — one concurrent refresh per chat. */
  refreshingMemory: Set<string>;
  /**
   * Message ids whose emotion picture is being chosen (`emotion.ts`) — per
   * message rather than per chat, since a round's replies each want one.
   */
  detectingEmotion: Set<string>;
  /**
   * What is being embedded for SillyTavern's chat vectorization (`vectors.ts`):
   * a chat's messages (`chat:<chat id>`) — or a plot's Korean aliases being
   * written (`aliases:<plot id>`, `loreAliases.ts`)
   * — one pass each at a time, and a pass asked for meanwhile runs again after it.
   */
  embeddingVectors: Map<string, 'running' | 'again'>;
  /**
   * Chat ids with a reply suggestion in flight — one per chat. Its own guard
   * rather than the generation slot: a suggestion writes nothing, so it must not
   * stop the reader from sending the turn they were composing.
   */
  suggesting: Set<string>;
  /**
   * The server's text embedder (`embedder.ts`), for the memory's similar
   * summaries and whatever else searches by meaning; absent when it is off or
   * its weights were never fetched, and every caller then falls back. Tests
   * hand in their own.
   */
  embedder?: Embedder;
  /**
   * Lua `request`, made by this server for a card script (`scriptFetch.ts`): its
   * in-flight cap and RisuAI's rate limit live here, one per process. Defaults
   * to the real network with the web origin refused; tests hand it a stub DNS
   * and connection.
   */
  scriptFetch?: ScriptFetch;
  /**
   * What an import fetches of the pictures, stylesheets and fonts a card loads
   * from other hosts (`localizeAssets.ts`): the guarded network with this app's
   * own hosts refused by default; tests hand in their own.
   */
  remoteFetch?: RemoteFetch;
  /**
   * Runs a card's request triggers (`requestTriggers.ts`); the worker pool by
   * default. Tests wrap it to shorten its deadline or to count its runs.
   */
  runRequestTriggers?: RequestTriggerRunner;
  /**
   * Runs a card's Lua `editRequest` listeners (`requestLua.ts`); the child
   * process pool by default. Tests wrap it to shorten its deadline, to count its
   * runs, or to answer the sandbox probe.
   */
  runRequestLua?: RequestLuaRunner;
  /**
   * The readers' `editRequest` globals kept between generations, a reader and member each (`requestLua.ts`);
   * the process's own store by default. Tests hand their own to look inside.
   */
  luaStates?: LuaStateStore;
  /** Adapter factory; defaults to the model registry. Overridden in tests. */
  getAdapter?: (...args: Parameters<typeof getAdapter>) => ReturnType<typeof getAdapter> | Awaited<ReturnType<typeof getAdapter>>;
  /**
   * Sink for fire-and-forget work started after a response is finished. The tasks
   * already swallow their errors; tests use this to await them, and the kind tells
   * the two independent jobs apart.
   */
  onBackgroundTask?: (task: Promise<void>, kind: BackgroundTaskKind) => void;
}

export interface AppEnv {
  Variables: {
    /** The owner, whose id every `user_id` column holds; set by `ownerGate` on every request past it. */
    userId: string;
    /** Whether the request came from this computer rather than a paired phone (`requireLocal`). */
    local: boolean;
  };
}

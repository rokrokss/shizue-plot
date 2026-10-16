import type { Db } from '@shizue/db';
import type { getAdapter } from '@shizue/llm';
import type { ChatGPTAccounts } from './chatgptAccounts.js';
import type { Embedder } from './embedder.js';
import type { AppAuth, SessionStore } from './hostedAuth.js';
import type { RemoteFetch } from './localizeAssets.js';
import type { SceneImageGenerator } from './sceneImage.js';
import type { LuaStateStore, RequestLuaRunner } from './requestLua.js';
import type { RequestTriggerRunner } from './requestTriggers.js';
import type { ScriptFetch } from './scriptFetch.js';
import type { ObjectStorage } from './storage.js';

/** The db handle inside a transaction — same query surface as `Db`. */
export type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

/** The fire-and-forget jobs a finished turn — or a plot's write, or a search — can start. */
export type BackgroundTaskKind = 'memory' | 'relationship' | 'emotion' | 'vectors' | 'aliases' | 'search';

/**
 * A generation claim this instance holds: the exact `chats.generating_at` it
 * wrote (the identity every renewal and release compares against) and the one
 * renewal allowed in flight at a time, so overlapping heartbeats join rather
 * than race each other.
 */
export interface GenerationClaim {
  at: Date;
  renewing: Promise<void> | null;
}

/** A generation stream this instance has open (`AppDeps.generationStreams`). */
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
  auth: AppAuth;
  /** Sign in with ChatGPT and the sessions it opens; absent in tests that do not sign in. */
  chatgpt?: { accounts: ChatGPTAccounts; sessions: SessionStore };
  /** Avatars, plot assets and chat attachments; the local driver by default. */
  storage: ObjectStorage;
  /** Environment used for LLM provider gating. */
  env: NodeJS.ProcessEnv;
  /**
   * Chat ids this instance holds the generation slot for — one concurrent
   * generation per chat. Only a fast path in front of the claim on `chats`, which
   * is the authority and the part that holds across API instances.
   */
  generating: Set<string>;
  /**
   * The exact `chats.generating_at` this instance wrote, by chat id — the identity
   * of the claim it holds. Renewal and release compare against it before they
   * touch the column, so an instance whose stale claim was taken over by another
   * cannot write over, or clear, the new holder's.
   */
  generationClaims: Map<string, GenerationClaim>;
  /** The generation streams this instance has open, for the reader's stop and shutdown (`stopChatGeneration`, `stopGenerations`). */
  generationStreams: Set<OpenGeneration>;
  /** Chat ids with a memory refresh in flight — one concurrent refresh per chat. */
  refreshingMemory: Set<string>;
  /** Chat ids with a relationship extraction in flight; separate from the memory guard. */
  extractingRelationship: Set<string>;
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
  /** User ids with a plot draft in flight — one draft at a time per creator. */
  drafting: Set<string>;
  /**
   * The server's text embedder (`embedder.ts`), for the memory's similar
   * summaries and whatever else searches by meaning; absent when it is off or
   * its weights were never fetched, and every caller then falls back. Tests
   * hand in their own.
   */
  embedder?: Embedder;
  /**
   * Lua `request`, made by this server for a card script (`scriptFetch.ts`): its
   * rate limit lives here, one per process. Defaults to the real network with
   * the web origin refused; tests hand it a stub DNS and connection.
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
   * Test seam for historical scene-image persistence. No production image provider.
   */
  generateSceneImage?: SceneImageGenerator;
  /**
   * Sink for fire-and-forget work started after a response is finished. The tasks
   * already swallow their errors; tests use this to await them, and the kind tells
   * the two independent jobs apart.
   */
  onBackgroundTask?: (task: Promise<void>, kind: BackgroundTaskKind) => void;
  /** Set once a shutdown begins: `GET /api/ready` answers 503 from then on (`health.ts`, `index.ts`). */
  draining?: boolean;
}

export interface AppEnv {
  Variables: {
    /**
     * Who is reading, or null when nobody is signed in. Every public surface
     * branches on this one; the session resolver sets it on every `/api/*`
     * request.
     */
    viewerId: string | null;
    /**
     * The signed-in user. Set only when a session resolved, so it is typed as a
     * plain string and may only be read **behind `requireUser`** — which is what
     * makes that true. Anything a reader without an account may reach reads
     * `viewerId` instead.
     */
    userId: string;
  };
}

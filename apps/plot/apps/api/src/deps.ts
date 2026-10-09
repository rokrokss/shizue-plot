import type { Db } from '@shizue/db';
import type { getAdapter } from '@shizue/llm';
import type { ChatGPTAccounts } from './chatgptAccounts.js';
import type { AppAuth, SessionStore } from './hostedAuth.js';
import type { SceneImageGenerator } from './sceneImage.js';
import type { ObjectStorage } from './storage.js';

/** The db handle inside a transaction — same query surface as `Db`. */
export type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

/** The fire-and-forget jobs a finished turn can start. */
type BackgroundTaskKind = 'memory' | 'relationship';

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
  /** Chat ids with a memory refresh in flight — one concurrent refresh per chat. */
  refreshingMemory: Set<string>;
  /** Chat ids with a relationship extraction in flight; separate from the memory guard. */
  extractingRelationship: Set<string>;
  /**
   * Chat ids with a reply suggestion in flight — one per chat. Its own guard
   * rather than the generation slot: a suggestion writes nothing, so it must not
   * stop the reader from sending the turn they were composing.
   */
  suggesting: Set<string>;
  /** User ids with a plot draft in flight — one draft at a time per creator. */
  drafting: Set<string>;
  /** Historical vector-memory tests can inject an embedder; local ChatGPT has none. */
  createEmbedder?: (timeoutMs?: number) => { embed(input: string[]): Promise<number[][]> } | undefined;
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

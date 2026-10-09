import { account, session, user, verification, type Db } from '@shizue/db';
import {
  authorizationUrl, callbackResult, ChatGPTError, ChatGPTOAuth, createPendingSignIn, loopbackRedirectUri, providerError,
  type ChatGPTAccount, type ChatGPTIdentity, type ChatGPTModel, type ChatGPTTokens, type PendingSignIn,
} from '@shizue/llm';
import { and, eq, gt, like, lt, sql } from 'drizzle-orm';
import { createCipheriv, createDecipheriv, createHash, createHmac, hkdfSync, randomBytes, randomUUID } from 'node:crypto';
import type { Tx } from './deps.js';

/**
 * Sign in with ChatGPT for many readers on one server. Each reader's tokens live
 * on their `account` row, sealed with a key derived from the app secret; model
 * calls read them through `forUser`. The browser never sees a token: OpenAI's
 * loopback callback reaches `/api/chatgpt/callback` through the companion
 * extension (apps/extension), and the server finishes the exchange there.
 */
const PROVIDER = 'chatgpt';
const PENDING_PREFIX = 'chatgpt-sign-in:';
const PENDING_TTL_MS = 10 * 60_000;
const CATALOG_TTL_MS = 30_000;
/** Refresh outcomes that mean the grant is gone; anything else may be transient. */
const REVOKED = ['invalid_grant', 'chatgpt_identity_mismatch', 'chatgpt_missing_plan_scope'];
const CLEARED = { accessToken: null, refreshToken: null, idToken: null, accessTokenExpiresAt: null, scope: null };
export const SIGN_IN_LOCALES = ['ko', 'en', 'ja'] as const;
export type SignInLocale = (typeof SIGN_IN_LOCALES)[number];
export interface SignInTarget { next: string; locale: SignInLocale }
const DEFAULT_TARGET: SignInTarget = { next: '/', locale: 'ko' };

/** A failed callback, with where the reader should land to try again. */
export class SignInFailure extends Error {
  constructor(readonly code: string, readonly target: SignInTarget) { super(code); }
}

const sha256 = (value: string): string => createHash('sha256').update(value).digest('hex');

/** AES-256-GCM with a key derived from the app secret; `v1.iv.body.tag`. */
export function tokenCipher(secret: string): { seal(value: string): string; open(value: string): string } {
  const key = Buffer.from(hkdfSync('sha256', secret, 'shizue', 'chatgpt-token-encryption', 32));
  return {
    seal(value) {
      const iv = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', key, iv);
      const body = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
      return ['v1', iv.toString('base64url'), body.toString('base64url'), cipher.getAuthTag().toString('base64url')].join('.');
    },
    open(value) {
      const [version, iv, body, tag] = value.split('.');
      if (version !== 'v1' || !iv || !body || !tag) throw new Error('Unreadable sealed token');
      const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64url'));
      decipher.setAuthTag(Buffer.from(tag, 'base64url'));
      return Buffer.concat([decipher.update(Buffer.from(body, 'base64url')), decipher.final()]).toString('utf8');
    },
  };
}

/**
 * This server is one host to OpenAI. Derived from the secret so it is chosen
 * before the first sign-in and survives restarts without a table of its own.
 */
export function hostIdFor(secret: string): string {
  const hex = createHmac('sha256', secret).update('chatgpt-host-id').digest('hex').slice(0, 32).split('');
  hex[12] = '4';
  hex[16] = '89ab'[parseInt(hex[16]!, 16) % 4]!;
  const id = hex.join('');
  return `urn:uuid:${id.slice(0, 8)}-${id.slice(8, 12)}-${id.slice(12, 16)}-${id.slice(16, 20)}-${id.slice(20)}`;
}

export interface ChatGPTAccounts {
  forUser(userId: string): ChatGPTAccount;
  status(userId: string): Promise<{ connected: boolean; email: string | null }>;
  /** `binding` goes into an HttpOnly cookie; the callback must present it. */
  startSignIn(input: { clientHint?: string; target: SignInTarget }): Promise<{ authorizationUrl: string; binding: string }>;
  /** Throws `SignInFailure`. */
  finishSignIn(params: URLSearchParams, binding: string | undefined): Promise<{ userId: string; clientId: string; target: SignInTarget }>;
  /** Revokes and forgets the tokens, keeps the registration, ends every session. */
  signOut(userId: string): Promise<{ revocationPending: boolean }>;
}

export function createChatGPTAccounts(db: Db, options: { secret: string; callbackPort: number; oauth?: ChatGPTOAuth }): ChatGPTAccounts {
  const oauth = options.oauth ?? new ChatGPTOAuth();
  const cipher = tokenCipher(options.secret);
  const hostId = hostIdFor(options.secret);
  const redirectUri = loopbackRedirectUri(options.callbackPort);
  const catalogs = new Map<string, { expires: number; models: ChatGPTModel[] }>();

  const sealed = (tokens: ChatGPTTokens) => ({
    accessToken: cipher.seal(tokens.accessToken),
    refreshToken: cipher.seal(tokens.refreshToken),
    idToken: tokens.idToken ? cipher.seal(tokens.idToken) : null,
    accessTokenExpiresAt: new Date(tokens.expiresAt),
    scope: tokens.scope,
    updatedAt: new Date(),
  });
  type Row = typeof account.$inferSelect;
  /** Null when signed out — or when the secret changed and the seal no longer opens. */
  const opened = (row: Row | undefined): ChatGPTTokens | null => {
    if (!row?.accessToken || !row.refreshToken || !row.accessTokenExpiresAt) return null;
    try {
      return {
        accessToken: cipher.open(row.accessToken), refreshToken: cipher.open(row.refreshToken),
        ...(row.idToken ? { idToken: cipher.open(row.idToken) } : {}),
        scope: row.scope ?? '', expiresAt: row.accessTokenExpiresAt.getTime(),
      };
    } catch { return null; }
  };
  const fresh = (tokens: ChatGPTTokens): boolean => tokens.expiresAt >= Date.now() + 60_000;
  const rowOf = async (userId: string): Promise<Row | undefined> =>
    (await db.select().from(account).where(and(eq(account.userId, userId), eq(account.providerId, PROVIDER))).limit(1))[0];

  async function accessToken(userId: string): Promise<string> {
    const row = await rowOf(userId);
    const tokens = opened(row);
    if (!row?.clientId || !tokens) throw providerError('chatgpt_login_required', 401);
    if (fresh(tokens)) return tokens.accessToken;
    // Refresh tokens rotate, so one refresh per account at a time: under the row lock,
    // and re-read there in case another request already rotated it.
    const outcome = await db.transaction(async (tx): Promise<{ token: string } | { error: unknown }> => {
      const [locked] = await tx.select().from(account).where(eq(account.id, row.id)).for('update');
      const current = opened(locked);
      if (!locked?.clientId || !current) return { error: providerError('chatgpt_login_required', 401) };
      if (fresh(current)) return { token: current.accessToken };
      try {
        const next = await oauth.refresh(locked.clientId, current, locked.accountId);
        await tx.update(account).set(sealed(next)).where(eq(account.id, locked.id));
        return { token: next.accessToken };
      } catch (error) {
        if (error instanceof ChatGPTError && REVOKED.includes(error.code)) {
          await tx.update(account).set({ ...CLEARED, updatedAt: new Date() }).where(eq(account.id, locked.id));
          catalogs.delete(userId);
        }
        return { error };
      }
    });
    if ('error' in outcome) throw outcome.error;
    return outcome.token;
  }

  async function persist(identity: ChatGPTIdentity, clientId: string, tokens: ChatGPTTokens): Promise<string> {
    return db.transaction(async (tx) => {
      // One sign-in persists at a time: two first sign-ins of one account, and the
      // one that adopts the local workspace owner below, must not interleave.
      await tx.execute(sql`select pg_advisory_xact_lock(73124018)`);
      const values = { ...sealed(tokens), clientId };
      const [existing] = await tx.select().from(account)
        .where(and(eq(account.providerId, PROVIDER), eq(account.accountId, identity.subject))).limit(1);
      if (existing) {
        await tx.update(account).set(values).where(eq(account.id, existing.id));
        return existing.userId;
      }
      const owner = await adoptLocalOwner(tx, identity) ?? await createUser(tx, identity);
      await tx.insert(account).values({ id: randomUUID(), providerId: PROVIDER, accountId: identity.subject, userId: owner, ...values });
      return owner;
    });
  }

  return {
    forUser(userId) {
      return {
        accessToken: () => accessToken(userId),
        async models() {
          const cached = catalogs.get(userId);
          if (cached && cached.expires > Date.now()) return cached.models;
          const models = await oauth.models(await accessToken(userId));
          catalogs.set(userId, { expires: Date.now() + CATALOG_TTL_MS, models });
          return models;
        },
      };
    },

    async status(userId) {
      const row = await rowOf(userId);
      if (!opened(row)) return { connected: false, email: null };
      const [owner] = await db.select({ email: user.email }).from(user).where(eq(user.id, userId)).limit(1);
      return { connected: true, email: owner && !owner.email.endsWith('.invalid') ? owner.email : null };
    },

    async startSignIn({ clientHint, target }) {
      // Reuse a registration only while an account here still holds it.
      const [known] = clientHint
        ? await db.select({ clientId: account.clientId }).from(account)
          .where(and(eq(account.providerId, PROVIDER), eq(account.clientId, clientHint))).limit(1)
        : [];
      const pending = createPendingSignIn(redirectUri, known?.clientId ?? undefined);
      const binding = randomBytes(32).toString('base64url');
      await db.delete(verification).where(and(like(verification.identifier, `${PENDING_PREFIX}%`), lt(verification.expiresAt, new Date())));
      await db.insert(verification).values({
        id: randomUUID(),
        identifier: PENDING_PREFIX + pending.state,
        value: JSON.stringify({ ...pending, binding: sha256(binding), target }),
        expiresAt: new Date(Date.now() + PENDING_TTL_MS),
      });
      return { authorizationUrl: authorizationUrl(pending, hostId), binding };
    },

    async finishSignIn(params, binding) {
      const state = params.get('state');
      // Single use: the attempt is gone whether or not it succeeds.
      const [row] = state
        ? await db.delete(verification)
          .where(and(eq(verification.identifier, PENDING_PREFIX + state), gt(verification.expiresAt, new Date())))
          .returning()
        : [];
      if (!row) throw new SignInFailure('chatgpt_invalid_state', DEFAULT_TARGET);
      const saved = JSON.parse(row.value) as PendingSignIn & { binding: string; target: SignInTarget };
      try {
        // Only the browser that started the attempt may finish it (login CSRF).
        if (!binding || sha256(binding) !== saved.binding) throw providerError('chatgpt_invalid_state', 400);
        const { code, clientId } = callbackResult(params, saved);
        const { tokens, identity } = await oauth.exchange(saved, code, clientId);
        catalogs.clear();
        return { userId: await persist(identity, clientId, tokens), clientId, target: saved.target };
      } catch (error) {
        if (!(error instanceof ChatGPTError)) console.error('[chatgpt] sign-in failed', error);
        throw new SignInFailure(error instanceof ChatGPTError ? error.code : 'chatgpt_login_failed', saved.target);
      }
    },

    async signOut(userId) {
      // Under the row lock, so a refresh in flight finishes first and its rotated
      // token is the one revoked.
      const held = await db.transaction(async (tx) => {
        const [row] = await tx.select().from(account)
          .where(and(eq(account.userId, userId), eq(account.providerId, PROVIDER))).for('update');
        if (!row) return null;
        await tx.update(account).set({ ...CLEARED, updatedAt: new Date() }).where(eq(account.id, row.id));
        return { clientId: row.clientId, tokens: opened(row) };
      });
      catalogs.delete(userId);
      await db.delete(session).where(eq(session.userId, userId));
      const revoked = held?.clientId && held.tokens ? await oauth.revoke(held.clientId, held.tokens.refreshToken) : true;
      return { revocationPending: !revoked };
    },
  };
}

/**
 * The single owner a former local installation created keeps its plots and
 * chats: the first ChatGPT account to sign in takes it over, once.
 */
async function adoptLocalOwner(tx: Tx, identity: ChatGPTIdentity): Promise<string | null> {
  const [binding] = await tx.delete(account)
    .where(and(eq(account.providerId, 'local-workspace'), eq(account.accountId, 'default'))).returning();
  if (!binding) return null;
  await tx.update(user).set({ ...await profile(tx, identity), updatedAt: new Date() }).where(eq(user.id, binding.userId));
  return binding.userId;
}

async function createUser(tx: Tx, identity: ChatGPTIdentity): Promise<string> {
  const [created] = await tx.insert(user).values({ id: randomUUID(), ...await profile(tx, identity) }).returning({ id: user.id });
  return created!.id;
}

/** `user.email` is unique and required; an address another user holds is not taken over. */
async function profile(tx: Tx, identity: ChatGPTIdentity): Promise<{ name: string; email: string }> {
  const taken = identity.email
    ? (await tx.select({ id: user.id }).from(user).where(eq(user.email, identity.email)).limit(1)).length > 0
    : true;
  return {
    name: identity.name ?? identity.email?.split('@')[0] ?? 'ChatGPT',
    email: taken ? `${randomUUID()}@users.shizue.invalid` : identity.email!,
  };
}

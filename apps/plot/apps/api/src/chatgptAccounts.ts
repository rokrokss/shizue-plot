import { account, user, verification, type Db } from '@shizue/db';
import {
  authorizationUrl, callbackResult, ChatGPTError, ChatGPTOAuth, createPendingSignIn, loopbackRedirectUri, providerError, withAccessToken,
  type ChatGPTAccount, type ChatGPTIdentity, type ChatGPTModel, type ChatGPTTokens, type PendingSignIn,
} from '@shizue/llm';
import { and, eq, gt, like, lt, ne } from 'drizzle-orm';
import { createCipheriv, createDecipheriv, createHash, createHmac, hkdfSync, randomBytes, randomUUID } from 'node:crypto';
import type { Tx } from './deps.js';

/**
 * The owner's ChatGPT connection: Sign in with ChatGPT as the way to their own
 * plan, not a login. The tokens live on the owner's one `account` row
 * (`chatgpt/<sub>`), sealed with a key derived from the install's secret; model
 * calls read them through `forUser`. The browser never sees a token: OpenAI's
 * loopback callback reaches `/api/chatgpt/callback` through the Shizue
 * extension's redirect rule, and the server finishes the exchange there.
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

/** A failed callback, with the locale the owner should land in to try again. */
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
 * This install is one host to OpenAI. Derived from the secret so it is chosen
 * before the first connection and survives restarts without a table of its own.
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
  /** Stores the tokens as `owner`'s one connection. Throws `SignInFailure`. */
  finishSignIn(params: URLSearchParams, binding: string | undefined, owner: string): Promise<{ clientId: string; target: SignInTarget }>;
  /** Revokes and forgets the tokens and keeps the registration; nothing else ends with them. */
  disconnect(userId: string): Promise<{ revocationPending: boolean }>;
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
  /** Null when disconnected — or when the secret changed and the seal no longer opens. */
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

  /**
   * `rejected` is a token the provider turned down while its `expiresAt` still
   * looked fresh: refreshed all the same, unless another request already rotated it.
   */
  async function accessToken(userId: string, rejected?: string): Promise<string> {
    const usable = (tokens: ChatGPTTokens): boolean => fresh(tokens) && tokens.accessToken !== rejected;
    const row = await rowOf(userId);
    const tokens = opened(row);
    if (!row?.clientId || !tokens) throw providerError('chatgpt_login_required', 401);
    if (usable(tokens)) return tokens.accessToken;
    // Refresh tokens rotate, so one refresh per account at a time: under the row lock,
    // and re-read there in case another request already rotated it.
    const outcome = await db.transaction(async (tx): Promise<{ token: string } | { error: unknown }> => {
      const [locked] = await tx.select().from(account).where(eq(account.id, row.id)).for('update');
      const current = opened(locked);
      if (!locked?.clientId || !current) return { error: providerError('chatgpt_login_required', 401) };
      if (usable(current)) return { token: current.accessToken };
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

  /**
   * One connection at a time: the owner's row for another ChatGPT account goes,
   * and this account's row, made or kept, is the owner's. A replaced account
   * whose tokens no disconnect let go has its grant revoked as a disconnect does.
   */
  async function persist(owner: string, identity: ChatGPTIdentity, clientId: string, tokens: ChatGPTTokens): Promise<void> {
    const replaced = await db.transaction(async (tx) => {
      const values = { ...sealed(tokens), clientId, userId: owner };
      const gone = await tx.delete(account)
        .where(and(eq(account.providerId, PROVIDER), eq(account.userId, owner), ne(account.accountId, identity.subject)))
        .returning();
      await tx.insert(account).values({ id: randomUUID(), providerId: PROVIDER, accountId: identity.subject, ...values })
        .onConflictDoUpdate({ target: [account.providerId, account.accountId], set: values });
      await nameOwner(tx, owner, identity);
      return gone;
    });
    for (const row of replaced) {
      const held = opened(row);
      if (row.clientId && held) await oauth.revoke(row.clientId, held.refreshToken);
    }
  }

  return {
    forUser(userId) {
      return {
        accessToken: (rejected) => accessToken(userId, rejected),
        async models() {
          const cached = catalogs.get(userId);
          if (cached && cached.expires > Date.now()) return cached.models;
          const models = await withAccessToken((rejected) => accessToken(userId, rejected), (token) => oauth.models(token));
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

    async finishSignIn(params, binding, owner) {
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
        await persist(owner, identity, clientId, tokens);
        return { clientId, target: saved.target };
      } catch (error) {
        // Name and message only: an Error printed whole shows its own fields, and
        // jose's claim errors carry the ID token's decoded payload — the owner's email.
        if (!(error instanceof ChatGPTError)) {
          console.error(`[chatgpt] sign-in failed: ${error instanceof Error ? `${error.name}: ${error.message}` : 'unknown error'}`);
        }
        throw new SignInFailure(error instanceof ChatGPTError ? error.code : 'chatgpt_login_failed', saved.target);
      }
    },

    async disconnect(userId) {
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
      const revoked = held?.clientId && held.tokens ? await oauth.revoke(held.clientId, held.tokens.refreshToken) : true;
      return { revocationPending: !revoked };
    },
  };
}

/**
 * The owner takes the connected account's name and address, which the settings
 * card shows. `user.email` is unique; an address another row holds is not
 * taken over, and the owner keeps the one it has.
 */
async function nameOwner(tx: Tx, owner: string, identity: ChatGPTIdentity): Promise<void> {
  const taken = identity.email
    ? (await tx.select({ id: user.id }).from(user).where(and(eq(user.email, identity.email), ne(user.id, owner))).limit(1)).length > 0
    : true;
  await tx.update(user).set({
    name: identity.name ?? identity.email?.split('@')[0] ?? 'ChatGPT',
    ...(taken ? {} : { email: identity.email! }),
    updatedAt: new Date(),
  }).where(eq(user.id, owner));
}

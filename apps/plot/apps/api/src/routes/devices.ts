import { verification } from '@shizue/db';
import { and, eq, gt, like, lt } from 'drizzle-orm';
import { Hono } from 'hono';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { AppDeps, AppEnv } from '../deps.js';
import { ApiError, badRequest, notFound } from '../errors.js';
import { TunnelError } from '../tunnel.js';
import { requireUser } from '../session.js';
import { readJsonBody, requireString } from '../util.js';

/** `verification.identifier` of a pairing code: this, then the code's digest. */
const PAIRING_PREFIX = 'device-pairing:';
const PAIRING_TTL_MS = 5 * 60_000;
const digest = (code: string): string => createHash('sha256').update(code).digest('hex');

/**
 * The origins a phone opens this machine's shizue at, besides the sign-in one:
 * those `REMOTE_ORIGINS` lists and the tunnel the settings page opened. Read on
 * every request, as the guards do.
 */
export function remoteOriginsOf(deps: AppDeps): string[] {
  const tunnel = deps.phoneAccess?.origin();
  return [...new Set([...(deps.remoteOrigins ?? []), ...(tunnel ? [tunnel] : [])])];
}

/**
 * Pairing a phone to the reader signed in on a shizue running on their own
 * machine, which the phone reaches through a tunnel — opened from the settings
 * page (`tunnel.ts`), or one the reader runs and lists in `REMOTE_ORIGINS`. A phone
 * cannot finish Sign in with ChatGPT — its callback is a loopback address the
 * companion extension catches, and phones run no extension — so the browser that
 * signed in hands it a one-time code instead, as a QR code, and the phone trades
 * it for a session of its own. The ChatGPT tokens stay on the server either way.
 *
 * Only on this machine: the hosted app, which signs in elsewhere than loopback,
 * has no tunnel and none of this exists there.
 */
export function deviceRoutes(deps: AppDeps): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  const sessions = (): NonNullable<AppDeps['chatgpt']>['sessions'] => {
    if (!deps.chatgpt) throw new ApiError(503, 'chatgpt_unavailable', 'Sign in with ChatGPT is not configured');
    return deps.chatgpt.sessions;
  };
  const phoneAccess = deps.phoneAccess;
  app.use('*', async (c, next) => {
    if (!phoneAccess) throw notFound();
    c.header('Cache-Control', 'no-store');
    await next();
  });
  /** A tunnel that cannot open says why, in words the settings card shows. */
  const tunnelCall = async <T>(call: () => Promise<T>): Promise<T> => {
    try {
      return await call();
    } catch (error) {
      if (error instanceof TunnelError) {
        throw new ApiError(error.code === 'tunnel_unavailable' ? 409 : 502, error.code, error.message);
      }
      throw error;
    }
  };
  const state = async (): Promise<unknown> => ({ ...(await phoneAccess!.status()), origins: remoteOriginsOf(deps) });

  /** What the settings card shows: the open tunnel, which one the button would open, and every address a phone can use. */
  app.get('/', requireUser, async (c) => c.json(await state()));

  /** Opens the tunnel — Tailscale Serve when this machine is on a tailnet, else a Cloudflare Quick Tunnel. */
  app.post('/tunnel', requireUser, async (c) => {
    await tunnelCall(() => phoneAccess!.open());
    return c.json(await state());
  });

  /** Closes it: Tailscale's port for this app only, or the cloudflared this API started. */
  app.delete('/tunnel', requireUser, async (c) => {
    await tunnelCall(() => phoneAccess!.close());
    return c.json(await state());
  });

  /** A code for the reader's phone, single use and five minutes long, and the tunnels it can open it at. */
  app.post('/pair', requireUser, async (c) => {
    sessions();
    const origins = remoteOriginsOf(deps);
    if (origins.length === 0) throw new ApiError(409, 'no_tunnel', 'Open phone access first: there is no tunnel to this machine');
    const code = randomBytes(32).toString('base64url');
    const expiresAt = new Date(Date.now() + PAIRING_TTL_MS);
    await deps.db.delete(verification).where(and(like(verification.identifier, `${PAIRING_PREFIX}%`), lt(verification.expiresAt, new Date())));
    await deps.db.insert(verification).values({
      id: randomUUID(), identifier: PAIRING_PREFIX + digest(code), value: JSON.stringify({ userId: c.get('userId') }), expiresAt,
    });
    return c.json({ code, expiresAt: expiresAt.toISOString(), origins });
  });

  /**
   * The phone's side: a POST from the page the code opened, never a GET, so a
   * link alone cannot sign a browser into someone else's account. The code is
   * gone whether or not it is still good.
   */
  app.post('/claim', async (c) => {
    const store = sessions();
    const code = requireString(await readJsonBody(c), 'code');
    const [row] = await deps.db.delete(verification)
      .where(and(eq(verification.identifier, PAIRING_PREFIX + digest(code)), gt(verification.expiresAt, new Date())))
      .returning();
    if (!row) throw badRequest('pairing_invalid', 'This pairing code has expired or was already used');
    const { userId } = JSON.parse(row.value) as { userId: string };
    c.header('Set-Cookie', await store.create(userId, c.req.raw, { paired: true }));
    return c.body(null, 204);
  });

  return app;
}

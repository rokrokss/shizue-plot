import { verification } from '@shizue/db';
import { and, eq, gt, like, lt } from 'drizzle-orm';
import { Hono, type MiddlewareHandler } from 'hono';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { AppDeps, AppEnv } from '../deps.js';
import { ApiError, badRequest, notFound } from '../errors.js';
import { TunnelError } from '../tunnel.js';
import { requireLocal, type SessionStore } from '../session.js';
import { readJsonBody, requireString } from '../util.js';

/** `verification.identifier` of a pairing code: this, then the code's digest. */
const PAIRING_PREFIX = 'device-pairing:';
const PAIRING_TTL_MS = 5 * 60_000;
const digest = (code: string): string => createHash('sha256').update(code).digest('hex');

/**
 * The origins a phone opens this machine's shizue at, besides the web origin:
 * those `REMOTE_ORIGINS` lists and the tunnel the settings page opened. Read on
 * every request, as the guards do.
 */
export function remoteOriginsOf(deps: AppDeps): string[] {
  const tunnel = deps.phoneAccess?.origin();
  return [...new Set([...(deps.remoteOrigins ?? []), ...(tunnel ? [tunnel] : [])])];
}

/** None of it without a tunnel manager (`index.ts`), and nothing of it cached. */
const withPhoneAccess = (deps: AppDeps): MiddlewareHandler<AppEnv> => async (c, next) => {
  if (!deps.phoneAccess) throw notFound();
  c.header('Cache-Control', 'no-store');
  await next();
};

/**
 * The phone's side of pairing, mounted in front of `ownerGate` (app.ts) since
 * the phone has no session yet: a POST from the page the code opened, never a
 * GET, so a link alone cannot let a browser in. The code is gone whether or not
 * it is still good.
 */
export function deviceClaimRoutes(deps: AppDeps, sessions: SessionStore): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  app.post('/claim', withPhoneAccess(deps), async (c) => {
    const code = requireString(await readJsonBody(c), 'code');
    const [row] = await deps.db.delete(verification)
      .where(and(eq(verification.identifier, PAIRING_PREFIX + digest(code)), gt(verification.expiresAt, new Date())))
      .returning();
    if (!row) throw badRequest('pairing_invalid', 'This pairing code has expired or was already used');
    const { userId } = JSON.parse(row.value) as { userId: string };
    c.header('Set-Cookie', await sessions.create(userId, c.req.raw));
    return c.body(null, 204);
  });
  return app;
}

/**
 * Opening the shizue running on this computer on a phone, which reaches it
 * through a tunnel — opened from the settings page (`tunnel.ts`), or one the
 * owner runs and lists in `REMOTE_ORIGINS`. Pairing is how a phone gets in: this
 * computer shows a one-time code as a QR code, and the phone trades it for a
 * session of its own (`deviceClaimRoutes`). Everything that lets a phone in is
 * this computer's alone (`requireLocal`); a paired phone may only read where it
 * stands and leave.
 */
export function deviceRoutes(deps: AppDeps, sessions: SessionStore): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  const phoneAccess = deps.phoneAccess;
  app.use('*', withPhoneAccess(deps));
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
  const state = async (local: boolean): Promise<unknown> => ({ ...(await phoneAccess!.status()), origins: remoteOriginsOf(deps), local });

  /**
   * What the settings card shows: the open tunnel, which one the button would
   * open, every address a phone can use, and whether this is the computer or a
   * paired phone.
   */
  app.get('/', async (c) => c.json(await state(c.get('local'))));

  /** Opens the tunnel — Tailscale Serve when this machine is on a tailnet, else a Cloudflare Quick Tunnel. */
  app.post('/tunnel', requireLocal, async (c) => {
    await tunnelCall(() => phoneAccess!.open());
    return c.json(await state(true));
  });

  /** Closes it: Tailscale's port for this app only, or the cloudflared this API started. */
  app.delete('/tunnel', requireLocal, async (c) => {
    await tunnelCall(() => phoneAccess!.close());
    return c.json(await state(true));
  });

  /** A code for the owner's phone, single use and five minutes long, and the tunnels it can open it at. */
  app.post('/pair', requireLocal, async (c) => {
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

  /** A paired phone leaves: its own session ends, and nothing else does. */
  app.delete('/session', async (c) => {
    await sessions.end(c.req.raw.headers);
    c.header('Set-Cookie', sessions.clearCookie());
    return c.body(null, 204);
  });

  return app;
}

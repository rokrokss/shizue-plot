import { personas, type Persona } from '@shizue/db';
import { and, asc, eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { MAX_IMAGE_BYTES, mimeForPath, storableImage } from '../avatar.js';
import type { AppDeps, AppEnv } from '../deps.js';
import { badRequest, notFound } from '../errors.js';
import { deleteQuietly, personaAvatarKey } from '../storage.js';
import { optionalString, readJsonBody, requireString, requireUuidParam } from '../util.js';

/** Same-origin path a persona's picture is served from; only its owner may read it. */
export const personaAvatarUrl = (persona: Pick<Persona, 'id' | 'avatarPath'>): string | null =>
  persona.avatarPath ? `/api/personas/${persona.id}/avatar` : null;

const toJson = (persona: Persona) => ({
  id: persona.id,
  name: persona.name,
  description: persona.description,
  avatarUrl: personaAvatarUrl(persona),
  createdAt: persona.createdAt.toISOString(),
});

async function loadOwnedPersona(deps: AppDeps, id: string, userId: string): Promise<Persona> {
  const [persona] = await deps.db
    .select()
    .from(personas)
    .where(and(eq(personas.id, id), eq(personas.userId, userId)))
    .limit(1);
  if (!persona) throw notFound('Persona not found');
  return persona;
}

export function personaRoutes(deps: AppDeps): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  app.get('/', async (c) => {
    const rows = await deps.db
      .select()
      .from(personas)
      .where(eq(personas.userId, c.get('userId')))
      .orderBy(asc(personas.createdAt));
    return c.json(rows.map(toJson));
  });

  app.post('/', async (c) => {
    const body = await readJsonBody(c);
    const name = requireString(body, 'name').trim();
    if (!name) throw badRequest('invalid_request', 'name must not be empty');

    const [created] = await deps.db
      .insert(personas)
      .values({
        userId: c.get('userId'),
        name,
        description: optionalString(body, 'description') ?? '',
      })
      .returning();
    return c.json(toJson(created!), 201);
  });

  app.get('/:id', async (c) => {
    const persona = await loadOwnedPersona(deps, requireUuidParam(c), c.get('userId'));
    return c.json(toJson(persona));
  });

  app.put('/:id', async (c) => {
    const id = requireUuidParam(c);
    const userId = c.get('userId');
    await loadOwnedPersona(deps, id, userId);
    const body = await readJsonBody(c);

    const name = optionalString(body, 'name')?.trim();
    if (name !== undefined && !name) throw badRequest('invalid_request', 'name must not be empty');
    const description = optionalString(body, 'description');

    const [updated] = await deps.db
      .update(personas)
      .set({
        ...(name !== undefined ? { name } : {}),
        ...(description !== undefined ? { description } : {}),
      })
      .where(and(eq(personas.id, id), eq(personas.userId, userId)))
      .returning();
    return c.json(toJson(updated!));
  });

  app.delete('/:id', async (c) => {
    const id = requireUuidParam(c);
    const userId = c.get('userId');
    const persona = await loadOwnedPersona(deps, id, userId);
    await deps.db.delete(personas).where(and(eq(personas.id, id), eq(personas.userId, userId)));
    if (persona.avatarPath) await deleteQuietly(deps.storage, persona.avatarPath);
    return c.body(null, 204);
  });

  /* ------------------------------------------------------------ the picture */

  /**
   * The persona's picture, through `storableImage` under the member avatar's cap
   * and codes. A persona is its owner's alone — the router is gated whole and
   * every read goes through `loadOwnedPersona` — so its picture is served the way
   * a chat attachment is: to that one account, never to a plot's readers.
   */
  app.post('/:id/avatar', async (c) => {
    const id = requireUuidParam(c);
    const userId = c.get('userId');
    const persona = await loadOwnedPersona(deps, id, userId);

    let form: FormData;
    try {
      form = await c.req.formData();
    } catch {
      throw badRequest('invalid_request', 'Expected multipart/form-data with a file field');
    }
    const file = form.get('file');
    if (!(file instanceof File)) throw badRequest('invalid_request', 'file field is required');
    // As on a member's avatar: the platform's 5MB body limit (app.ts) answers 413
    // first for anything near it; this names the file itself.
    if (file.size > MAX_IMAGE_BYTES) {
      throw badRequest('payload_too_large', `An avatar is at most ${MAX_IMAGE_BYTES} bytes`);
    }

    const image = storableImage(new Uint8Array(await file.arrayBuffer()));
    if (!image) throw badRequest('invalid_asset', 'Unsupported image file');

    const key = personaAvatarKey(id, image.ext);
    await deps.storage.put(key, image.bytes, image.mime);
    const [updated] = await deps.db
      .update(personas)
      .set({ avatarPath: key })
      .where(and(eq(personas.id, id), eq(personas.userId, userId)))
      .returning();
    // A re-upload in another format lands on a new key, so the old object is only
    // garbage once the row has stopped naming it.
    if (persona.avatarPath && persona.avatarPath !== key) {
      await deleteQuietly(deps.storage, persona.avatarPath);
    }
    return c.json(toJson(updated!));
  });

  app.delete('/:id/avatar', async (c) => {
    const id = requireUuidParam(c);
    const userId = c.get('userId');
    const persona = await loadOwnedPersona(deps, id, userId);

    const [updated] = await deps.db
      .update(personas)
      .set({ avatarPath: null })
      .where(and(eq(personas.id, id), eq(personas.userId, userId)))
      .returning();
    if (persona.avatarPath) await deleteQuietly(deps.storage, persona.avatarPath);
    return c.json(toJson(updated!));
  });

  app.get('/:id/avatar', async (c) => {
    const persona = await loadOwnedPersona(deps, requireUuidParam(c), c.get('userId'));
    if (!persona.avatarPath) throw notFound('Persona has no avatar');
    const object = await deps.storage.get(persona.avatarPath);
    if (!object) throw notFound('Avatar file is missing');
    return new Response(object.body, {
      headers: {
        'Content-Type': mimeForPath(persona.avatarPath),
        'Content-Length': String(object.size),
        'Cache-Control': 'private, max-age=3600',
      },
    });
  });

  return app;
}

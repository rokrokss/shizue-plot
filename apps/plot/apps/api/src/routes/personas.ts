import { personas, type Persona } from '@shizue/db';
import { and, asc, eq } from 'drizzle-orm';
import { Hono } from 'hono';
import type { AppDeps, AppEnv } from '../deps.js';
import { badRequest, notFound } from '../errors.js';
import { optionalString, readJsonBody, requireString, requireUuidParam } from '../util.js';

const toJson = (persona: Persona) => ({
  id: persona.id,
  name: persona.name,
  description: persona.description,
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
    await loadOwnedPersona(deps, id, userId);
    await deps.db.delete(personas).where(and(eq(personas.id, id), eq(personas.userId, userId)));
    return c.body(null, 204);
  });

  return app;
}

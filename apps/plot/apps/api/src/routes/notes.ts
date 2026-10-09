import { user, userNotes, type UserNote } from '@shizue/db';
import { and, asc, eq, sql } from 'drizzle-orm';
import { Hono } from 'hono';
import type { AppDeps, AppEnv } from '../deps.js';
import { badRequest } from '../errors.js';
import { loadOwnedNote, MAX_NOTE_LENGTH, MAX_USER_NOTES } from '../notes.js';
import { optionalString, readJsonBody, requireUuidParam } from '../util.js';

const toNoteJson = (note: UserNote) => ({
  id: note.id,
  title: note.title,
  content: note.content,
  groupName: note.groupName,
  createdAt: note.createdAt.toISOString(),
  updatedAt: note.updatedAt.toISOString(),
});

/** Body content, rejected past the per-note cap. */
function noteContent(body: Record<string, unknown>): string | undefined {
  const content = optionalString(body, 'content');
  if (content !== undefined && content.length > MAX_NOTE_LENGTH) {
    throw badRequest('note_limit', `content must be at most ${MAX_NOTE_LENGTH} characters`);
  }
  return content;
}

export function noteRoutes(deps: AppDeps): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  app.get('/', async (c) => {
    const group = c.req.query('group');
    const rows = await deps.db
      .select()
      .from(userNotes)
      .where(
        group === undefined
          ? eq(userNotes.userId, c.get('userId'))
          : and(eq(userNotes.userId, c.get('userId')), eq(userNotes.groupName, group)),
      )
      .orderBy(asc(userNotes.createdAt), asc(userNotes.id));
    return c.json(rows.map(toNoteJson));
  });

  app.post('/', async (c) => {
    const userId = c.get('userId');
    const body = await readJsonBody(c);
    const content = noteContent(body) ?? '';

    // The cap is a count, and a count only means something while nothing else can
    // insert. The account row is the stable thing every create for this user can
    // queue on, so two requests racing at 99 cannot both see room.
    const created = await deps.db.transaction(async (tx) => {
      await tx.select({ id: user.id }).from(user).where(eq(user.id, userId)).for('update');

      const [counted] = await tx
        .select({ value: sql<number>`count(*)::int` })
        .from(userNotes)
        .where(eq(userNotes.userId, userId));
      if ((counted?.value ?? 0) >= MAX_USER_NOTES) {
        throw badRequest('note_limit', `A user may keep at most ${MAX_USER_NOTES} notes`);
      }

      const [row] = await tx
        .insert(userNotes)
        .values({
          userId,
          title: optionalString(body, 'title') ?? '',
          content,
          groupName: optionalString(body, 'groupName') ?? '',
        })
        .returning();
      return row!;
    });
    return c.json(toNoteJson(created), 201);
  });

  app.put('/:id', async (c) => {
    const id = requireUuidParam(c);
    const userId = c.get('userId');
    await loadOwnedNote(deps, id, userId);
    const body = await readJsonBody(c);

    const title = optionalString(body, 'title');
    const content = noteContent(body);
    const groupName = optionalString(body, 'groupName');

    const [updated] = await deps.db
      .update(userNotes)
      .set({
        ...(title !== undefined ? { title } : {}),
        ...(content !== undefined ? { content } : {}),
        ...(groupName !== undefined ? { groupName } : {}),
        updatedAt: new Date(),
      })
      .where(and(eq(userNotes.id, id), eq(userNotes.userId, userId)))
      .returning();
    return c.json(toNoteJson(updated!));
  });

  app.delete('/:id', async (c) => {
    const id = requireUuidParam(c);
    const userId = c.get('userId');
    await loadOwnedNote(deps, id, userId);
    // The links go with it: chat_note_links cascades on note_id.
    await deps.db.delete(userNotes).where(and(eq(userNotes.id, id), eq(userNotes.userId, userId)));
    return c.body(null, 204);
  });

  return app;
}

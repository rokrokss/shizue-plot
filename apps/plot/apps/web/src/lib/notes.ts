import type { UserNote } from './types';

interface NoteGroup {
  /** '' is the ungrouped bucket, which always comes first. */
  name: string;
  notes: UserNote[];
}

/**
 * Notes bucketed by their group name for the folded list. The ungrouped bucket
 * leads, the named ones follow in locale order; notes keep the server's order.
 */
export function groupNotes(notes: UserNote[]): NoteGroup[] {
  const groups = new Map<string, UserNote[]>();
  for (const note of notes) {
    const bucket = groups.get(note.groupName);
    if (bucket) bucket.push(note);
    else groups.set(note.groupName, [note]);
  }
  return [...groups.entries()]
    .map(([name, grouped]) => ({ name, notes: grouped }))
    .sort((a, b) => (a.name === '' || b.name === '' ? (a.name === '' ? -1 : 1) : a.name.localeCompare(b.name)));
}

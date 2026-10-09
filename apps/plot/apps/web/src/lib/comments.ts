/** Client-side tree edits for the comment section, mirroring the API's rules. */

import type { Comment } from './types';

/** Newest first at the top level, oldest first inside a thread — as the API lists them. */
export function addComment(items: Comment[], comment: Comment): Comment[] {
  if (comment.parentId === null) return [comment, ...items];
  return items.map((item) =>
    item.id === comment.parentId ? { ...item, replies: [...item.replies, comment] } : item,
  );
}

/** What is left of a comment once it is deleted: its place in the thread, nothing else. */
const asPlaceholder = (comment: Comment): Comment => ({
  ...comment,
  content: '',
  spoiler: false,
  deleted: true,
  authorName: null,
  canDelete: false,
});

/**
 * Applies a delete the way the server does: a top-level comment that still
 * anchors replies becomes a placeholder, and anything else — a reply, or a
 * top-level comment with nothing under it — leaves the list. Dropping the last
 * reply of a placeholder takes the placeholder with it.
 */
export function removeComment(items: Comment[], id: string): Comment[] {
  return items.flatMap((item) => {
    if (item.id === id) return item.replies.length > 0 ? [asPlaceholder(item)] : [];
    if (!item.replies.some((reply) => reply.id === id)) return [item];
    const replies = item.replies.filter((reply) => reply.id !== id);
    if (replies.length === 0 && item.deleted) return [];
    return [{ ...item, replies }];
  });
}

import { describe, expect, it } from 'vitest';
import { addComment, removeComment } from '../src/lib/comments';
import type { Comment } from '../src/lib/types';

const comment = (id: string, parentId: string | null = null, replies: Comment[] = []): Comment => ({
  id,
  parentId,
  content: `내용 ${id}`,
  spoiler: false,
  deleted: false,
  authorName: `작성자 ${id}`,
  createdAt: '2026-01-01T00:00:00.000Z',
  canDelete: true,
  replies,
});

describe('addComment', () => {
  it('puts a new top-level comment first', () => {
    const items = addComment([comment('a')], comment('b'));
    expect(items.map((item) => item.id)).toEqual(['b', 'a']);
  });

  it('appends a reply to its parent and leaves the others alone', () => {
    const items = addComment([comment('a', null, [comment('a1', 'a')]), comment('b')], comment('a2', 'a'));
    expect(items[0]!.replies.map((reply) => reply.id)).toEqual(['a1', 'a2']);
    expect(items[1]!.replies).toEqual([]);
  });
});

describe('removeComment', () => {
  it('drops a top-level comment that anchors nothing', () => {
    expect(removeComment([comment('a'), comment('b')], 'a').map((item) => item.id)).toEqual(['b']);
  });

  it('leaves a placeholder behind while replies remain', () => {
    const items = removeComment([comment('a', null, [comment('a1', 'a')])], 'a');
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      id: 'a',
      content: '',
      spoiler: false,
      deleted: true,
      authorName: null,
      canDelete: false,
    });
    expect(items[0]!.replies.map((reply) => reply.id)).toEqual(['a1']);
  });

  it('always drops a reply, and takes the placeholder it was holding up with it', () => {
    const placeholder: Comment = {
      ...comment('a', null, [comment('a1', 'a'), comment('a2', 'a')]),
      content: '',
      deleted: true,
      authorName: null,
      canDelete: false,
    };

    const withOneLeft = removeComment([placeholder], 'a1');
    expect(withOneLeft[0]!.replies.map((reply) => reply.id)).toEqual(['a2']);
    expect(removeComment(withOneLeft, 'a2')).toEqual([]);
  });

  it('keeps a live comment that has lost its last reply', () => {
    const items = removeComment([comment('a', null, [comment('a1', 'a')])], 'a1');
    expect(items.map((item) => item.id)).toEqual(['a']);
    expect(items[0]!.replies).toEqual([]);
  });
});

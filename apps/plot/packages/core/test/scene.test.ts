import { describe, expect, it } from 'vitest';
import { isSceneMessage, sceneSpanAt, type SceneMessage } from '../src/scene.js';

const user = (content: string): SceneMessage => ({ role: 'user', content });
const assistant = (content: string): SceneMessage => ({ role: 'assistant', content });

describe('isSceneMessage', () => {
  it('takes every assistant turn, and the reader\'s only when it is narration', () => {
    expect(isSceneMessage(assistant('안녕'))).toBe(true);
    expect(isSceneMessage(assistant('@: 문이 열린다'))).toBe(true);
    expect(isSceneMessage(user('@: 문이 열린다'))).toBe(true);
    expect(isSceneMessage(user('안녕'))).toBe(false);
  });

  it('reads the prefix the way narration does, leading space and all', () => {
    expect(isSceneMessage(user('  @: 비가 내린다'))).toBe(true);
    expect(isSceneMessage(user('메일 주소는 @: 아니다'))).toBe(false);
  });
});

describe('sceneSpanAt', () => {
  // greeting, the reader's line, a reply, a narration, another reply.
  const path = [
    assistant('안녕하세요'),
    user('안녕'),
    assistant('반가워'),
    user('@: 문이 열린다'),
    assistant('누구지'),
  ];

  it('grows the run in both directions and stops at the reader\'s dialogue', () => {
    expect(sceneSpanAt(path, 2)).toEqual({ start: 2, end: 5 });
    expect(sceneSpanAt(path, 3)).toEqual({ start: 2, end: 5 });
    expect(sceneSpanAt(path, 4)).toEqual({ start: 2, end: 5 });
  });

  it('takes the greeting root as a scene of its own', () => {
    expect(sceneSpanAt(path, 0)).toEqual({ start: 0, end: 1 });
  });

  it('has no scene for the reader\'s dialogue, or for an index off the path', () => {
    expect(sceneSpanAt(path, 1)).toBeNull();
    expect(sceneSpanAt(path, 5)).toBeNull();
    expect(sceneSpanAt([], 0)).toBeNull();
  });

  it('spans the whole path when nothing breaks it', () => {
    expect(sceneSpanAt([assistant('하나'), user('@: 둘'), assistant('셋')], 0)).toEqual({
      start: 0,
      end: 3,
    });
  });
});

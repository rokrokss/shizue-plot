/**
 * What a row learns from the rows around it. Every timestamp here is built from
 * local calendar parts rather than written out as UTC: a day boundary is the
 * reader's, so the suite has to mean the same thing in any timezone.
 */
import { describe, expect, it } from 'vitest';
import { chatRowMeta, relativeDay, type ChatRowInput } from '../src/lib/chatRows';

const at = (
  year: number,
  month: number,
  day: number,
  hour: number,
  minute = 0,
): string => new Date(year, month - 1, day, hour, minute).toISOString();

const row = (
  role: ChatRowInput['role'],
  content: string,
  createdAt: string | null,
): ChatRowInput => ({ role, content, createdAt });

describe('chatRowMeta', () => {
  it('hands each row the last thing its own role said', () => {
    const meta = chatRowMeta([
      row('assistant', '첫 인사', at(2026, 8, 11, 9)),
      row('user', '안녕', at(2026, 8, 11, 9, 1)),
      row('assistant', '두 번째', at(2026, 8, 11, 9, 2)),
      row('user', '또 안녕', at(2026, 8, 11, 9, 3)),
    ]);
    expect(meta.map((entry) => entry.previousSameRole)).toEqual(['', '', '첫 인사', '안녕']);
  });

  it('starts a day between messages, but never on the first one', () => {
    const meta = chatRowMeta([
      row('assistant', '어제의 인사', at(2026, 8, 10, 22)),
      row('user', '자정 넘어', at(2026, 8, 11, 1)),
      row('assistant', '같은 날', at(2026, 8, 11, 2)),
    ]);
    expect(meta[0]!.dayStart).toBeNull();
    expect(meta[1]!.dayStart).toBe(at(2026, 8, 11, 1));
    expect(meta[2]!.dayStart).toBeNull();
  });

  it('groups a run of one speaker, and breaks it after five minutes', () => {
    const meta = chatRowMeta([
      row('user', '첫 줄', at(2026, 8, 11, 9)),
      row('user', '이어서', at(2026, 8, 11, 9, 4)),
      row('user', '한참 뒤', at(2026, 8, 11, 9, 10)),
      row('assistant', '답', at(2026, 8, 11, 9, 11)),
    ]);
    expect(meta.map((entry) => entry.grouped)).toEqual([false, true, false, false]);
  });

  it('leaves narration out of every group, and the row after it too', () => {
    const meta = chatRowMeta([
      row('assistant', '대사 하나', at(2026, 8, 11, 9)),
      row('assistant', '@: 문이 열렸다', at(2026, 8, 11, 9, 1)),
      row('assistant', '대사 둘', at(2026, 8, 11, 9, 2)),
    ]);
    expect(meta.map((entry) => entry.grouped)).toEqual([false, false, false]);
  });

  it('never groups across a day divider', () => {
    const meta = chatRowMeta([
      row('user', '자기 전에', at(2026, 8, 10, 23, 58)),
      row('user', '자정 직후', at(2026, 8, 11, 0, 1)),
    ]);
    expect(meta[1]!.dayStart).not.toBeNull();
    expect(meta[1]!.grouped).toBe(false);
  });

  it('lets an unstored row continue the run it is being typed into', () => {
    const meta = chatRowMeta([
      row('assistant', '지난 답', at(2026, 8, 11, 9)),
      row('user', '보내는 중', null),
      row('assistant', '생성 중', null),
    ]);
    // No timestamp is no day of its own, so nothing draws a divider mid-send.
    expect(meta.every((entry) => entry.dayStart === null)).toBe(true);
    expect(meta.map((entry) => entry.grouped)).toEqual([false, false, false]);

    const run = chatRowMeta([
      row('user', '보낸 것', at(2026, 8, 11, 9)),
      row('user', '보내는 중', null),
    ]);
    expect(run[1]!.grouped).toBe(true);
  });
});

describe('relativeDay', () => {
  const now = new Date(2026, 7, 11, 15, 30);

  it('names today and yesterday, and nothing else', () => {
    expect(relativeDay(at(2026, 8, 11, 1), now)).toBe('today');
    expect(relativeDay(at(2026, 8, 10, 23), now)).toBe('yesterday');
    expect(relativeDay(at(2026, 8, 9, 23), now)).toBeNull();
  });

  it('counts back over a month boundary', () => {
    expect(relativeDay(at(2026, 7, 31, 20), new Date(2026, 7, 1, 9))).toBe('yesterday');
  });
});

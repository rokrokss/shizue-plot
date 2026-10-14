import { describe, expect, it } from 'vitest';
import { luaCbs, type LuaCbsCall } from '../src/lua/cbsEngine.js';

/** A call as the worker holds one (`context` in `lua/runtime.ts`). */
const call = (extra: Partial<LuaCbsCall> = {}): LuaCbsCall => ({
  vars: new Map([['hp', '10']]),
  globals: new Map([['toggle_DLC_First', '1']]),
  char: { name: '리안', nickname: '', description: '사서.', firstMessage: '첫 인사' },
  lore: [{ key: '도서관', comment: '도서관', content: '조용한 곳' }],
  localLore: [],
  user: '아린',
  persona: '{{user}}는 여행자',
  messages: [
    { role: 'user', data: '안녕', time: 1 },
    { role: 'char', data: '어서 와', time: 2 },
  ],
  ...extra,
});

describe('luaCbs — RisuAI’s cbs() in Lua', () => {
  it('answers {{trigger_id}} with the manual run’s id, and `null` outside one', () => {
    // Magical Girl Life reads the button's row from it: `tostring(cbs('{{trigger_id}}') or '')`.
    expect(luaCbs('{{trigger_id}}', call({ cbs: { triggerId: '3' } }))).toBe('3');
    expect(luaCbs('{{trigger_id}}', call({ cbs: { triggerId: null } }))).toBe('null');
    expect(luaCbs('{{triggerid}}', call())).toBe('null');
  });

  it('reads a toggle through #when’s `tis`, as 당나라 무협 asks', () => {
    const text = '{{#when::DLC_First::tis::1}}1{{:else}}0{{/when}}';
    expect(luaCbs(text, call())).toBe('1');
    expect(luaCbs(text, call({ globals: new Map() }))).toBe('0');
  });

  it('reads the variables as the script has left them, and the name a setName gave', () => {
    const live = call();
    (live.vars as Map<string, string>).set('hp', '7');
    expect(luaCbs('{{getvar::hp}} {{calc::{{getvar::hp}}*2}} {{getglobalvar::toggle_DLC_First}}', live)).toBe('7 14 1');
    expect(luaCbs('{{char}}·{{bot}}·<char>·{{user}}', call({ char: { ...call().char, name: '세라' } }))).toBe('세라·세라·세라·아린');
    expect(luaCbs('{{char}}', call({ char: { ...call().char, nickname: '리' } }))).toBe('리');
    // An unset one reads RisuAI's `null`, which cards compare against.
    expect(luaCbs('{{getvar::missing}}|{{getglobalvar::missing}}', call())).toBe('null|null');
  });

  it('answers the rest of the language: blocks, the chat, the card, the lore', () => {
    expect(luaCbs('{{#if {{equal::{{getvar::hp}}::10}}}}있다{{/if}}', call())).toBe('있다');
    // At index -1, as RisuAI parses it: `lastusermessage` reads nothing there, as upstream's does.
    expect(luaCbs('{{lastmessage}}|{{lastusermessage}}|{{chat_index}}', call())).toBe('어서 와||-1');
    expect(luaCbs('{{description}}', call())).toBe('사서.');
    expect(luaCbs('{{personality}}', call({ cbs: { character: { personality: '차분함' } } }))).toBe('차분함');
    // RisuAI's shape: an array of each entry's JSON.
    const lore = (JSON.parse(luaCbs('{{lorebook}}', call())) as string[]).map((entry) => JSON.parse(entry) as unknown);
    expect(lore).toEqual([{ key: '도서관', comment: '도서관', content: '조용한 곳' }]);
    // RisuAI's runVar is off in cbs(): a setvar is left as written.
    expect(luaCbs('{{setvar::hp::1}}', call())).toBe('{{setvar::hp::1}}');
  });

  it('reads the reader’s clock as the snapshot carries it', () => {
    const clock = { now: Date.UTC(2026, 9, 14, 3, 4, 5), timeZone: 'Asia/Seoul', locale: 'ko-KR' };
    // RisuAI's own unpadded UTC time.
    expect(luaCbs('{{isotime}}', call({ cbs: { clock } }))).toBe('3:4:5');
  });
});

import { describe, expect, it } from 'vitest';
import type { LoreEntry } from '../src/types.js';
import {
  parseCommand,
  processMultiCommand,
  runCommands,
  runTriggers,
  splitCommands,
  type CommandAnswer,
  type CommandHost,
  type TriggerCharacter,
  type TriggerMessage,
  type TriggerRequest,
  type TriggerRunInput,
  type TriggerScript,
  type TriggerStep,
} from '../src/triggers/index.js';
import { emptyVariables, type Variables } from '../src/variables.js';

const vars = (entries: Record<string, string> = {}): Variables => Object.assign(emptyVariables(), entries);

const chat = (...texts: string[]): TriggerMessage[] =>
  texts.map((data, index) => ({ role: index % 2 === 0 ? 'user' : 'char', data, id: `m${index}` }));

/** A host over a plain chat, the way the composer's commands see it; CBS left alone. */
function host(messages: TriggerMessage[] = chat('안녕', '어서 와', '좋아'), variables: Variables = vars()) {
  const sent: { items: string[]; clear: boolean }[] = [];
  const triggered: string[] = [];
  const h: CommandHost = {
    cbs: (text) => text,
    chat: { messages },
    getVar: (name) => variables[name],
    setVar: (name, value) => {
      variables[name] = value;
    },
    *trigger(name) {
      triggered.push(name);
    },
    multisend: (items, clear) => void sent.push({ items, clear }),
    *lore() {
      return { actives: [{ depth: 0, pos: '', prompt: '북쪽의 성', role: 'system', order: 100, tokens: 3, priority: 100, source: '성', inject: null }], matchLog: [] };
    },
  };
  return { h, variables, sent, triggered };
}

/** Drives a line, answering the dialogs from `answers` in order and noting every request. */
function run(line: string, h: CommandHost, answers: unknown[] = []): { answer: CommandAnswer; requests: TriggerRequest[] } {
  const requests: TriggerRequest[] = [];
  const gen = processMultiCommand(line, h);
  let step = gen.next();
  while (!step.done) {
    requests.push(step.value);
    step = gen.next(step.value.kind === 'input' || step.value.kind === 'select' ? answers.shift() : undefined);
  }
  return { answer: step.value, requests };
}

describe('the parser', () => {
  it('splits on pipes outside double quotes and keeps the quotes', () => {
    expect(splitCommands('/echo a|/pass "b|c" d|')).toEqual(['/echo a', '/pass "b|c" d', '']);
    expect(splitCommands('/multisend a|||b')).toEqual(['/multisend a', '', '', 'b']);
  });

  it('reads named arguments at their first `=`, and puts the pipe in once with replace’s patterns', () => {
    expect(parseCommand('/setvar key=hp=3  10 {{pipe}} {{pipe}}', 'x')).toEqual({
      name: 'setvar',
      arg: '10 x {{pipe}}',
      named: Object.assign(Object.create(null), { key: 'hp' }),
    });
    expect(parseCommand('echo {{slot}}', '$&!').arg).toBe('{{slot}}!');
    expect(parseCommand('/echo {{pipe}}', undefined).arg).toBe('undefined');
    expect(parseCommand('/', '').name).toBeUndefined();
  });
});

describe('the commands', () => {
  it('passes the pipe along, takes an empty argument from it, and stops at false', () => {
    const { h } = host();
    expect(run('/pass 하나|/pass|/echo 둘|/pass {{pipe}}셋', h)).toMatchObject({
      answer: '하나셋',
      requests: [{ kind: 'alert', text: '둘' }],
    });
    // `/setinput` is not implemented in RisuAI, and an unknown command answers false too.
    expect(run('/pass a|/setinput b|/echo never', h)).toEqual({ answer: false, requests: [] });
    expect(run('/nope', h).answer).toBe(false);
    expect(run('/pass a||/echo never', h)).toEqual({ answer: false, requests: [] });
  });

  it('asks the reader, and answers /buttons with the index of the label chosen', () => {
    const { h } = host();
    expect(run('/input 이름은?', h, ['아린'])).toEqual({ answer: '아린', requests: [{ kind: 'input', text: '이름은?' }] });
    // The dialog answers with the index, as text, and that is the line's answer as it is.
    expect(run('/buttons labels=["예","아니요"]', h, ['1'])).toEqual({
      answer: '1',
      requests: [{ kind: 'select', options: ['예', '아니요'] }],
    });
    // Labels RisuAI joins with `||` split again, so the index counts the buttons drawn; not a list leaves the pipe.
    expect(run('/buttons labels=["a||b",3,null]', h, ['2'])).toEqual({
      answer: '2',
      requests: [{ kind: 'select', options: ['a', 'b', '3', ''] }],
    });
    expect(run('/pass x|/buttons labels=nope', h).answer).toBe('x');
    // Closed without a choice.
    expect(run('/buttons labels=["a"]', h, ['']).answer).toBe('');
    expect(run('/?', h)).toEqual({ answer: 'help', requests: [{ kind: 'help' }] });
  });

  it('sends, sends as the character and comments on the stored chat', () => {
    const { h } = host();
    run('/send 문을 연다|/sendas 들어와.|/comment 메모', h);
    expect(h.chat.messages.slice(3)).toEqual([
      { role: 'user', data: '문을 연다' },
      { role: 'char', data: '들어와.<Comment>\n메모\n</Comment>' },
    ]);
  });

  it('cuts as RisuAI does: a range slices, an index keeps only what it cuts, anything else is an id', () => {
    const cut = (arg: string): string[] => {
      const { h } = host(chat('a', 'b', 'c', 'd'));
      run(`/cut ${arg}`, h);
      return h.chat.messages.map((message) => message.data);
    };
    expect(cut('1-3')).toEqual(['b', 'c']);
    expect(cut('2-')).toEqual([]);
    expect(cut('-2')).toEqual(['a', 'b']);
    expect(cut('1')).toEqual(['b']);
    expect(cut('9')).toEqual([]);
    expect(cut('m2')).toEqual(['a', 'b', 'd']);
    const del = (arg: string): string[] => {
      const { h } = host(chat('a', 'b', 'c', 'd'));
      run(`/del ${arg}`, h);
      return h.chat.messages.map((message) => message.data);
    };
    // `/del N` keeps the last N.
    expect(del('1')).toEqual(['d']);
    expect(del('x')).toEqual(['a', 'b', 'c', 'd']);
  });

  it('sets, adds to and reads variables, and throws on reading an unset one', () => {
    const { h, variables } = host(undefined, vars({ hp: '10' }));
    expect(run('/addvar key=hp 5|/getvar key=hp', h).answer).toBe('15');
    expect(run('/setvar key=name 아린', h).answer).toBe('');
    expect(variables['name']).toBe('아린');
    expect(run('/addvar key=gold 1', h).answer).toBe('');
    expect(variables['gold']).toBe('NaN');
    expect(() => run('/getvar key=nothing', h)).toThrow();
    expect(() => run('/comment x', host([]).h)).toThrow();
    // `/trigger` leaves no pipe, which an empty argument then cannot read.
    expect(() => run('/trigger 공격|/echo', h)).toThrow();
  });

  it('counts a list, and hands multisend its items and test_lorebook its answer', () => {
    const { h, sent, triggered } = host();
    expect(run('/len ["a","b"]', h).answer).toBe('2');
    expect(run('/pass x|/len nope', h).answer).toBe('x');
    expect(run('/multisend 가', h).answer).toBe('');
    expect(sent).toEqual([{ items: ['가'], clear: false }]);
    const lore = run('/test_lorebook', h);
    expect(lore.requests).toEqual([{ kind: 'alert', text: '북쪽의 성' }]);
    expect(JSON.parse(lore.answer as string).actives[0].source).toBe('성');
    expect(run('/trigger 공격|/echo 끝', h).answer).toBeUndefined();
    expect(triggered).toEqual(['공격']);
  });
});

/* ---------------------------------------------------------- inside a run */

const trigger = (type: TriggerScript['type'], effect: TriggerStep[], extra: Partial<TriggerScript> = {}): TriggerScript => ({
  comment: '',
  type,
  conditions: [],
  effect,
  ...extra,
});

const command = (value: string): TriggerStep => ({ type: 'command', value });
const set = (variable: string, value: string): TriggerStep => ({
  type: 'v2SetVar',
  var: variable,
  value,
  operator: '=',
  valueType: 'value',
  indent: 0,
});

const character = (triggers: TriggerScript[], extra: Partial<TriggerCharacter> = {}): TriggerCharacter => ({
  name: '리안',
  description: '사서.',
  lorebook: [],
  postHistoryInstructions: '',
  lowLevelAccess: false,
  triggers,
  ...extra,
});

function input(triggers: TriggerScript[], extra: Partial<TriggerRunInput> = {}): TriggerRunInput {
  return {
    mode: 'start',
    character: character(triggers),
    messages: chat('안녕', '어서 와'),
    note: '',
    persona: '여행자',
    variables: vars({ hp: '10' }),
    random: () => 0.5,
    ...extra,
  };
}

describe('commands in a trigger run', () => {
  it('act on the chat as stored, which the run’s own chat is written over', async () => {
    for (const mode of ['start', 'output', 'manual'] as const) {
      const result = await runTriggers(
        input(
          [
            trigger(mode, [
              command('/send 명령|/setvar key=hp 99|/cut 0-1'),
              { type: 'impersonate', role: 'char', value: '흉내' },
            ], { comment: '수동' }),
          ],
          { mode, ...(mode === 'manual' ? { manualName: '수동' } : {}) },
        ),
      );
      expect(result.messages.map((message) => message.data), mode).toEqual(['안녕', '어서 와', '흉내']);
      expect(result.variables['hp'], mode).toBe('10');
    }
  });

  it('keep their variables in an input run that changed none itself, and lose them to one that did', async () => {
    const kept = await runTriggers(
      input([trigger('input', [command('/setvar key=hp 99|/send 명령')])], { mode: 'input' }),
    );
    expect(kept.variables['hp']).toBe('99');
    expect(kept.variablesChanged).toBe(true);
    expect(kept.messages.map((message) => message.data)).toEqual(['안녕', '어서 와']);

    for (const order of [
      [command('/setvar key=hp 99'), set('mp', '1')],
      [set('mp', '1'), command('/setvar key=hp 99')],
    ]) {
      const lost = await runTriggers(input([trigger('input', order)], { mode: 'input' }));
      expect(lost.variables['hp']).toBe('10');
      expect(lost.variables['mp']).toBe('1');
    }
  });

  it('are read by the CBS until the run writes a variable, which drops them', async () => {
    const result = await runTriggers(
      input([
        trigger('start', [
          command('/setvar key=hp 99'),
          set('seen', '{{getvar::hp}}'),
          set('after', '{{getvar::hp}}'),
          // `/getvar` reads the stored chat too.
          command('/setvar key=x 1|/getvar key=hp|/setvar key=y'),
          set('y2', '{{getvar::y}}'),
        ]),
      ]),
    );
    expect(result.variables['seen']).toBe('99');
    expect(result.variables['after']).toBe('10');
    expect(result.variables['y2']).toBe('10');
  });

  it('leave the stored chat as the result when the run ends early', async () => {
    const result = await runTriggers(
      input([
        trigger('start', [
          command('/send 남는다|/setvar key=hp 1'),
          // RisuAI's `/getvar` of an unset variable throws, and the run with it.
          command('/getvar key=none'),
          { type: 'impersonate', role: 'char', value: '사라진다' },
        ]),
      ]),
    );
    expect(result.aborted).toBe(true);
    expect(result.messages.map((message) => message.data)).toEqual(['안녕', '어서 와', '남는다']);
    expect(result.variables['hp']).toBe('1');
  });

  it('run a manual trigger on the stored chat with /trigger, which becomes what it left', async () => {
    const manual = trigger('manual', [set('hp', '{{getvar::hp}}!'), { type: 'impersonate', role: 'char', value: '수동' }], {
      comment: '공격',
    });
    // The pipe `/trigger` leaves is `undefined`, which `{{pipe}}` writes as a word.
    const ended = await runTriggers(
      input([manual, trigger('input', [command('/setvar key=hp 50|/trigger 공격|/send {{pipe}}'), command('/getvar key=none')])], {
        mode: 'input',
      }),
    );
    expect(ended.aborted).toBe(true);
    expect(ended.messages.map((message) => message.data)).toEqual(['안녕', '어서 와', '수동', 'undefined']);
    expect(ended.variables['hp']).toBe('50!');
    // Run to its end, an input run that wrote nothing itself keeps the variables, not the chat.
    const done = await runTriggers(input([manual, trigger('input', [command('/setvar key=hp 50|/trigger 공격')])], { mode: 'input' }));
    expect(done.messages.map((message) => message.data)).toEqual(['안녕', '어서 와']);
    expect(done.variables['hp']).toBe('50!');
  });

  it('do not generate for /multisend, and answer /test_lorebook from whoever answers the lore', async () => {
    const lore: LoreEntry = {
      name: '성',
      keys: ['성'],
      secondaryKeys: [],
      selective: false,
      content: '북쪽의 성',
      enabled: true,
      constant: false,
      insertionOrder: 100,
      caseSensitive: false,
      useRegex: false,
      position: 'before_char',
    };
    const alerts: string[] = [];
    let asked: unknown;
    const result = await runTriggers(
      input([], {
        // In a run the line is read before it is split, so only quotes keep `|||` in one item — quotes and all.
        character: character(
          [trigger('start', [command('/multisend "가|||나"|/test_lorebook|/setvar key=lore'), command('/getvar key=none')])],
          { lorebook: [lore] },
        ),
      }),
      {
        alert: (text) => void alerts.push(text),
        lore: (request) => {
          asked = request;
          return {
            actives: [
              { depth: 0, pos: '', prompt: request.lorebook[0]!.content, role: 'system', order: 100, tokens: 3, priority: 100, source: '성', inject: null },
            ],
            matchLog: [],
          };
        },
      },
    );
    expect(asked).toEqual({ kind: 'lore', history: ['안녕', '어서 와', '"가', '나"'], lorebook: [lore] });
    expect(alerts).toEqual(['북쪽의 성']);
    // Ended early, so the stored chat stands: the items, with no reply to either.
    expect(result.messages.map((message) => message.data)).toEqual(['안녕', '어서 와', '"가', '나"']);
    expect(JSON.parse(result.variables['lore']!).actives[0].prompt).toBe('북쪽의 성');
  });

  it('activate the card’s book and then the chat’s own for /test_lorebook, as RisuAI’s `loadLoreBookV3Prompt` does', async () => {
    const entry = (name: string, content: string): LoreEntry => ({
      name,
      keys: [name],
      secondaryKeys: [],
      selective: false,
      content,
      enabled: true,
      constant: false,
      insertionOrder: 100,
      caseSensitive: false,
      useRegex: false,
      position: 'before_char',
    });
    let asked: { lorebook: readonly LoreEntry[] } | undefined;
    await runTriggers(
      input([], {
        character: character([trigger('start', [command('/test_lorebook')])], { lorebook: [entry('성', '북쪽의 성')] }),
        localLore: [entry('숲', '챗의 숲')],
      }),
      {
        alert: () => undefined,
        lore: (request) => {
          asked = request;
          return { actives: [], matchLog: [] };
        },
      },
    );
    expect(asked?.lorebook.map((book) => book.content)).toEqual(['북쪽의 성', '챗의 숲']);
  });
});

describe('a line from the composer', () => {
  it('keeps what it did to the chat and its variables, and answers false for a command RisuAI does not run', async () => {
    const result = await runCommands({
      command: '/send 문을 연다|/sendas 들어와.|/setvar key=hp 3|/pass {{getvar::hp}}',
      character: character([]),
      messages: chat('안녕', '어서 와'),
      note: '',
      persona: '',
      variables: vars({ hp: '10' }),
    });
    expect(result.answer).toBe('3');
    expect(result.messages.map((message) => message.data)).toEqual(['안녕', '어서 와', '문을 연다', '들어와.']);
    expect(result.variables['hp']).toBe('3');
    expect(result.variablesChanged).toBe(true);
    const unknown = await runCommands({ command: '/send 남는다|/모름', character: character([]), messages: [], note: '', persona: '', variables: vars() });
    expect(unknown.answer).toBe(false);
    expect(unknown.messages).toEqual([{ role: 'user', data: '남는다' }]);
  });

  it('hands back its multisends, runs /trigger as a button would, and says when a command threw', async () => {
    const result = await runCommands({
      command: '/multisend 가|/trigger 공격',
      character: character([trigger('manual', [set('hit', '1'), { type: 'impersonate', role: 'char', value: '벤다' }], { comment: '공격' })]),
      messages: chat('안녕'),
      note: '',
      persona: '',
      variables: vars(),
    });
    expect(result.multisend).toEqual([{ items: ['가'], clear: false }]);
    expect(result.messages.map((message) => message.data)).toEqual(['안녕', '벤다']);
    expect(result.variables['hit']).toBe('1');
    const thrown = await runCommands({ command: '/send 남는다|/getvar key=x', character: character([]), messages: [], note: '', persona: '', variables: vars() });
    expect(thrown.aborted).toBe(true);
    expect(thrown.answer).toBeUndefined();
    expect(thrown.messages).toEqual([{ role: 'user', data: '남는다' }]);
  });
});

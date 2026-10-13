import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { LoreEntry } from '../src/types.js';
import {
  cardScripts,
  checkScriptChat,
  hasTriggersFor,
  manualTriggerNames,
  MAX_SCRIPT_CHAT_TEXT,
  MAX_TRIGGER_STEPS,
  MAX_OVERLAY_NAME_LENGTH,
  mergeScriptOverlay,
  overlaidCard,
  overlayName,
  parseChatML,
  risuCalculate,
  runTriggers,
  runTriggersSync,
  scriptChatOf,
  scriptedMember,
  TRIGGER_CLASSIFICATION,
  type TriggerCharacter,
  type TriggerMessage,
  type TriggerRunInput,
  type TriggerScript,
  type TriggerStep,
} from '../src/triggers/index.js';
import { emptyVariables, type Variables } from '../src/variables.js';

const vars = (entries: Record<string, string> = {}): Variables => Object.assign(emptyVariables(), entries);

const trigger = (type: TriggerScript['type'], effect: TriggerStep[], extra: Partial<TriggerScript> = {}): TriggerScript => ({
  comment: '',
  type,
  conditions: [],
  effect,
  ...extra,
});

const lore = (name: string, content: string, keys: string[] = [name]): LoreEntry => ({
  name,
  keys,
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

const character = (triggers: TriggerScript[], extra: Partial<TriggerCharacter> = {}): TriggerCharacter => ({
  name: '리안',
  description: '사서.',
  lorebook: [],
  postHistoryInstructions: '',
  lowLevelAccess: false,
  triggers,
  ...extra,
});

const chat = (...texts: string[]): TriggerMessage[] =>
  texts.map((data, index) => ({ role: index % 2 === 0 ? 'user' : 'char', data, id: `m${index}` }));

function input(triggers: TriggerScript[], extra: Partial<TriggerRunInput> = {}): TriggerRunInput {
  return {
    mode: 'start',
    character: character(triggers),
    messages: chat('안녕', '어서 와'),
    note: '',
    persona: '여행자',
    variables: vars(),
    random: () => 0.5,
    ...extra,
  };
}

const set = (variable: string, value: string, operator = '=', valueType = 'value', indent = 0): TriggerStep => ({
  type: 'v2SetVar',
  var: variable,
  value,
  operator,
  valueType,
  indent,
});

describe('reading a card', () => {
  it('takes triggers and the two edit script types from extensions.risuai, and nothing else', () => {
    const scripts = cardScripts({
      extensions: {
        risuai: {
          triggerscript: [
            { comment: 'a', type: 'start', conditions: [], effect: [{ type: 'setvar', var: 'x', value: '1', operator: '=' }] },
            { comment: 'bad', type: 'whenever', conditions: [], effect: [] },
            'not a trigger',
            { comment: 'b', type: 'manual', conditions: [{ nope: true }], effect: [{ type: 'v2Header' }, { noType: 1 }] },
          ],
          customScripts: [
            { type: 'editdisplay', in: 'x', out: 'y' },
            { type: 'editinput', in: 'a', out: 'b' },
            { type: 'editoutput', in: '', out: 'b' },
            { type: 'editoutput', in: 'c', out: 'd', flag: 'g<move_top>', ableFlag: true },
          ],
          lowLevelAccess: true,
        },
      },
    });
    expect(scripts?.triggers.map((t) => t.comment)).toEqual(['a', 'b']);
    expect(scripts?.triggers[1]?.conditions).toEqual([]);
    expect(scripts?.triggers[1]?.effect).toEqual([{ type: 'v2Header' }]);
    expect(scripts?.editScripts).toEqual([
      { type: 'editinput', in: 'a', out: 'b' },
      { type: 'editoutput', in: 'c', out: 'd', flag: 'g<move_top>', ableFlag: true },
    ]);
    expect(scripts?.lowLevelAccess).toBe(true);
  });

  it('says a card with only display scripts carries none, and picks the first scripted member', () => {
    expect(cardScripts({ extensions: { risuai: { customScripts: [{ type: 'editdisplay', in: 'x', out: 'y' }] } } })).toBeNull();
    expect(cardScripts({ extensions: {} })).toBeNull();
    const plain = { id: 'a', card: { extensions: {} } };
    const scripted = { id: 'b', card: { extensions: { risuai: { triggerscript: [{ comment: '', type: 'start', conditions: [], effect: [] }] } } } };
    const other = { id: 'c', card: scripted.card };
    expect(scriptedMember([plain, scripted, other])?.member.id).toBe('b');
    expect(scriptedMember([plain])).toBeNull();
  });

  it('lists the names a button can call, without code triggers', () => {
    const triggers = [
      trigger('manual', [], { comment: '공격' }),
      trigger('start', [], { comment: '시작' }),
      trigger('manual', [{ type: 'triggerlua', code: '' }], { comment: '루아' }),
    ];
    expect([...manualTriggerNames(triggers)]).toEqual(['공격', '시작']);
    expect(hasTriggersFor(triggers, 'start')).toBe(true);
    expect(hasTriggersFor(triggers, 'output')).toBe(false);
    expect(hasTriggersFor(triggers, 'manual', '공격')).toBe(true);
  });
});

describe('modes and conditions', () => {
  it('runs only the triggers of its own mode, a manual run only those of its name', () => {
    const triggers = [
      trigger('start', [set('s', '1')]),
      trigger('output', [set('o', '1')]),
      trigger('manual', [set('m', '1')], { comment: '버튼' }),
      trigger('start', [set('n', '1')], { comment: '버튼' }),
    ];
    expect(runTriggersSync(input(triggers)).variables).toEqual(vars({ s: '1', n: '1' }));
    // A manual name runs every trigger with that name, whatever its own type.
    expect(runTriggersSync(input(triggers, { mode: 'manual', manualName: '버튼' })).variables).toEqual(
      vars({ m: '1', n: '1' }),
    );
  });

  it('compares var, value and chatindex conditions after CBS, and reads an unset variable as null', () => {
    const run = (conditions: TriggerStep[], variables: Variables = vars()) =>
      runTriggersSync(input([trigger('start', [set('hit', '1')], { conditions })], { variables })).variables['hit'];
    expect(run([{ type: 'var', var: 'hp', value: '10', operator: '>' }], vars({ hp: '20' }))).toBe('1');
    expect(run([{ type: 'var', var: 'hp', value: '10', operator: '>' }], vars({ hp: '5' }))).toBeUndefined();
    expect(run([{ type: 'var', var: 'hp', value: '', operator: 'null' }])).toBe('1');
    expect(run([{ type: 'var', var: 'on', value: '', operator: 'true' }], vars({ on: 'true' }))).toBe('1');
    expect(run([{ type: 'value', var: '{{getvar::a}}', value: 'b', operator: '=' }], vars({ a: 'b' }))).toBe('1');
    // Two messages after the greeting.
    expect(run([{ type: 'chatindex', value: '2', operator: '=' }])).toBe('1');
    // Every condition has to hold.
    expect(
      run([
        { type: 'chatindex', value: '2', operator: '=' },
        { type: 'var', var: 'x', value: '1', operator: '=' },
      ]),
    ).toBeUndefined();
  });

  it('searches the last messages for exists, the whole chat at depth 0', () => {
    const run = (type2: string, value: string, depth: number) =>
      runTriggersSync(
        input([trigger('start', [set('hit', '1')], { conditions: [{ type: 'exists', type2, value, depth }] })], {
          messages: chat('검을 뽑았다', '방패를 들었다', '도망쳤다'),
        }),
      ).variables['hit'];
    expect(run('loose', '방패', 2)).toBe('1');
    expect(run('loose', '검을', 2)).toBeUndefined();
    expect(run('loose', '검을', 0)).toBe('1');
    expect(run('strict', '도망쳤', 1)).toBeUndefined();
    expect(run('strict', '도망쳤다', 1)).toBe('1');
    expect(run('regex', '방패.+', 2)).toBe('1');
  });
});

describe('v1 effects', () => {
  it('does setvar arithmetic on numbers, NaN as 0, and stores what a bad operand makes', () => {
    const effect = (operator: string, value: string): TriggerStep => ({ type: 'setvar', var: 'hp', value, operator });
    const run = (operator: string, value: string, hp?: string) =>
      runTriggersSync(input([trigger('start', [effect(operator, value)])], { variables: vars(hp ? { hp } : {}) }))
        .variables['hp'];
    expect(run('+=', '5', '10')).toBe('15');
    expect(run('-=', '3')).toBe('-3');
    expect(run('*=', '2', 'abc')).toBe('0');
    expect(run('/=', '4', '10')).toBe('2.5');
    expect(run('+=', 'abc', '1')).toBe('NaN');
    expect(run('=', '{{getvar::hp}}!', '7')).toBe('7!');
  });

  it('gathers system prompts by place, and stop', () => {
    const result = runTriggersSync(
      input([
        trigger('start', [
          { type: 'systemprompt', location: 'start', value: 'A {{char}}' },
          { type: 'systemprompt', location: 'promptend', value: 'B' },
          { type: 'v2SystemPrompt', location: 'promptend', value: 'C', valueType: 'value', indent: 0 },
          { type: 'stop' },
        ]),
      ]),
    );
    expect(result.injections).toEqual({ start: 'A 리안\n\n', historyend: '', promptend: 'B\n\nC\n\n' });
    expect(result.stopSending).toBe(true);
  });

  it('runs a named trigger, and stops recursing at ten without low-level access', () => {
    const loop = trigger('manual', [{ type: 'setvar', var: 'n', value: '1', operator: '+=' }, { type: 'runtrigger', value: '반복' }], {
      comment: '반복',
    });
    const start = trigger('start', [{ type: 'runtrigger', value: '반복' }]);
    const plain = runTriggersSync(input([start, loop]));
    expect(plain.variables['n']).toBe('10');
    expect(plain.aborted).toBe(false);
    // With access the nesting goes on until our own cap stops it.
    const deep = runTriggersSync({ ...input([start, loop]), character: character([start, loop], { lowLevelAccess: true }) });
    expect(deep.aborted).toBe(true);
    expect(deep.log.some((entry) => entry.kind === 'limit')).toBe(true);
    expect(Number(deep.variables['n'])).toBeGreaterThan(10);
  });

  it('works on a copy of the chat: modify, cut and impersonate are seen by the run and returned', () => {
    const result = runTriggersSync(
      input(
        [
          trigger('output', [
            { type: 'modifychat', index: '1', value: '고쳐 쓴 대답' },
            { type: 'impersonate', role: 'user', value: '덧붙인 말' },
            { type: 'v2GetLastMessage', outputVar: 'last', indent: 0 },
            { type: 'cutchat', start: '0', end: '1' },
            { type: 'v2GetMessageCount', outputVar: 'count', indent: 0 },
          ]),
        ],
        { mode: 'output' },
      ),
    );
    expect(result.variables['last']).toBe('덧붙인 말');
    expect(result.variables['count']).toBe('1');
    expect(result.messages).toEqual([{ role: 'user', data: '안녕', id: 'm0' }]);
  });

  it('keeps the low-level effects behind the card’s access', () => {
    const effects: TriggerStep[] = [
      { type: 'extractRegex', value: 'hp=42', regex: 'hp=(\\d+)', flags: '', result: '$1', inputVar: 'hp' },
      { type: 'sendAIprompt' },
      { type: 'runImgGen', value: 'x', negValue: '', inputVar: 'img' },
    ];
    const without = runTriggersSync(input([trigger('output', effects)], { mode: 'output' }));
    expect(without.variables['hp']).toBeUndefined();
    expect(without.sendAIprompt).toBe(false);
    const withAccess = runTriggersSync({
      ...input([], { mode: 'output' }),
      character: character([trigger('output', effects)], { lowLevelAccess: true }),
    });
    expect(withAccess.variables['hp']).toBe('42');
    expect(withAccess.sendAIprompt).toBe(true);
    expect(withAccess.variables['img']).toBe('Error: Image generation failed');
  });

  it('asks its driver for alerts and answers', async () => {
    const alerts: string[] = [];
    const result = await runTriggers(
      {
        ...input([]),
        character: character(
          [
            trigger('start', [
              { type: 'showAlert', alertType: 'normal', value: '조심해', inputVar: '' },
              { type: 'showAlert', alertType: 'input', value: '이름은?', inputVar: 'name' },
              { type: 'v2GetAlertSelect', display: '골라', displayType: 'value', value: '검|활', valueType: 'value', outputVar: 'weapon', indent: 0 },
            ]),
          ],
          { lowLevelAccess: true },
        ),
      },
      {
        alert: (text) => void alerts.push(text),
        input: () => '아린',
        select: (options) => String(options.indexOf('활')),
      },
    );
    expect(alerts).toEqual(['조심해']);
    expect(result.variables['name']).toBe('아린');
    expect(result.variables['weapon']).toBe('1');
  });

  it('writes the index of the choice, as RisuAI’s select dialog answers, over the buttons it draws', async () => {
    const asked: { options: string[]; display?: string }[] = [];
    const result = await runTriggers(
      {
        ...input([]),
        character: character(
          [
            trigger('start', [
              { type: 'showAlert', alertType: 'select', value: '검||창§활', inputVar: 'v1' },
              { type: 'v2GetAlertSelect', display: '골라||덤', displayType: 'value', value: '검|활', valueType: 'value', outputVar: 'v2', indent: 0 },
            ]),
          ],
          { lowLevelAccess: true },
        ),
      },
      {
        select: (options, display) => {
          asked.push({ options, ...(display !== undefined ? { display } : {}) });
          return String(options.length - 1);
        },
      },
    );
    // Joined with `||` and split again: an option holding one is two buttons, and so is the rest of the text.
    expect(asked).toEqual([{ options: ['검', '창', '활'] }, { options: ['덤', '검', '활'], display: '골라' }]);
    // Text, as every RisuAI caller hands it on.
    expect(result.variables['v1']).toBe('2');
    expect(result.variables['v2']).toBe('2');
  });
});

describe('model calls', () => {
  // The run reads its triggers off the character, so the access flag and the
  // triggers have to arrive together.
  const llmInput = (steps: TriggerStep[], lowLevelAccess = true, extra: Partial<TriggerRunInput> = {}) =>
    input([], { character: character([trigger('start', steps)], { lowLevelAccess }), ...extra });
  const runLLM = (value: string, inputVar = 'out'): TriggerStep => ({ type: 'runLLM', value, inputVar });
  const v2RunLLM = (value: string, extra: Partial<TriggerStep> = {}): TriggerStep => ({
    type: 'v2RunLLM',
    value,
    valueType: 'value',
    model: 'model',
    outputVar: 'out',
    indent: 0,
    ...extra,
  });

  it('asks the model through the driver and writes its answer, ChatML read into turns', async () => {
    const asked: unknown[] = [];
    const chatML = '<|im_start|>system\n짧게.<|im_end|><|im_start|>user\n{{user}}에게 인사해<|im_end|>';
    const result = await runTriggers(llmInput([runLLM(chatML)]), {
      llm: (request) => {
        asked.push(request);
        return { ok: true, text: '안녕하세요' };
      },
    });
    expect(asked).toEqual([
      {
        kind: 'llm',
        model: 'model',
        messages: [
          { role: 'system', content: '짧게.' },
          { role: 'user', content: expect.stringContaining('에게 인사해') },
        ],
      },
    ]);
    expect(result.variables['out']).toBe('안녕하세요');
  });

  it("sends plain text as one user turn, and writes RisuAI's failure values", async () => {
    const failing = { llm: () => ({ ok: false as const, error: 'busy' }) };
    const v1 = await runTriggers(llmInput([runLLM('hi')]), failing);
    expect(v1.variables['out']).toBe('Error: busy');

    const asked: unknown[] = [];
    const v2 = await runTriggers(
      llmInput([v2RunLLM('prompt', { valueType: 'var', model: 'submodel' })], true, {
        variables: vars({ prompt: '날씨?' }),
      }),
      {
        llm: (request) => {
          asked.push(request);
          return { ok: false, error: 'down' };
        },
      },
    );
    expect(asked).toEqual([{ kind: 'llm', model: 'submodel', messages: [{ role: 'user', content: '날씨?' }] }]);
    expect(v2.variables['out']).toBe('null');
  });

  it('does nothing without lowLevelAccess, and runAxLLM does nothing at all, as in RisuAI', async () => {
    let calls = 0;
    const driver = {
      llm: () => {
        calls += 1;
        return { ok: true as const, text: 'x' };
      },
    };
    const locked = await runTriggers(
      llmInput([runLLM('hi'), v2RunLLM('hi')], false),
      driver,
    );
    expect(locked.variables['out']).toBeUndefined();
    const ax = await runTriggers(
      llmInput([{ type: 'runAxLLM', value: 'hi', inputVar: 'out' }]),
      driver,
    );
    expect(ax.variables['out']).toBeUndefined();
    expect(calls).toBe(0);
  });

  it('fails rather than calling the model where nothing can wait, or no one answers', async () => {
    const sync = runTriggersSync(llmInput([runLLM('hi')]));
    expect(sync.variables['out']).toBe('Error: model calls are not available here');
    const unanswered = await runTriggers(llmInput([v2RunLLM('hi')]));
    expect(unanswered.variables['out']).toBe('null');
  });

  it('reads ChatML the way RisuAI does', () => {
    expect(parseChatML('그냥 글')).toBeNull();
    expect(
      parseChatML(
        '<|im_start|>system<|im_sep|>규칙<|im_end|><|im_start|>assistant 네<Thoughts>속생각</Thoughts><|im_end|><|im_start|>무명 역할',
      ),
    ).toEqual([
      { role: 'system', content: '규칙' },
      { role: 'assistant', content: '네' },
      { role: 'user', content: '무명 역할' },
    ]);
  });
});

describe('embedding similarity', () => {
  const simInput = (steps: TriggerStep[], lowLevelAccess = true, extra: Partial<TriggerRunInput> = {}) =>
    input([], { character: character([trigger('start', steps)], { lowLevelAccess }), ...extra });
  const checkSimilarity = (value: string, source: string, inputVar = 'out'): TriggerStep => ({
    type: 'checkSimilarity',
    value,
    source,
    inputVar,
  });
  const v2CheckSimilarity = (extra: Partial<TriggerStep> = {}): TriggerStep => ({
    type: 'v2CheckSimilarity',
    source: '질문',
    sourceType: 'value',
    value: '가§나',
    valueType: 'value',
    outputVar: 'out',
    indent: 0,
    ...extra,
  });
  /** Answers with the texts reversed, and records what it was asked. */
  const reversing = (asked: unknown[]) => ({
    similarity: (request: { source: string; texts: string[] }) => {
      asked.push(request);
      return { ok: true as const, texts: [...request.texts].reverse() };
    },
  });

  it('asks with the value split on §, after CBS, and writes the answer joined with § to the raw inputVar', async () => {
    const asked: unknown[] = [];
    const result = await runTriggers(
      simInput([checkSimilarity('{{char}}§검§§{{getvar::item}}', '{{user}}의 무기', '{{getvar::item}}')], true, {
        variables: vars({ item: '활' }),
        data: { user: '아린' },
      }),
      reversing(asked),
    );
    expect(asked).toEqual([{ kind: 'similarity', source: '아린의 무기', texts: ['리안', '검', '', '활'] }]);
    // v1 names its variable as written, CBS and all, as RisuAI's `setVar(effect.inputVar, …)` does.
    expect(result.variables['{{getvar::item}}']).toBe('활§§검§리안');
    expect(result.variables['활']).toBeUndefined();
  });

  it('reads v2 fields as values or variables, and names the output through CBS', async () => {
    const asked: unknown[] = [];
    const result = await runTriggers(
      simInput(
        [v2CheckSimilarity({ source: 'q', sourceType: 'var', value: 'list', valueType: 'var', outputVar: 'best_{{getvar::n}}' })],
        true,
        { variables: vars({ q: '바다', list: '산§강§바다', n: '1' }) },
      ),
      reversing(asked),
    );
    expect(asked).toEqual([{ kind: 'similarity', source: '바다', texts: ['산', '강', '바다'] }]);
    expect(result.variables['best_1']).toBe('바다§강§산');
    // An unset variable reads as the string null, which is one text.
    const unset: unknown[] = [];
    await runTriggers(simInput([v2CheckSimilarity({ value: 'missing', valueType: 'var' })]), reversing(unset));
    expect(unset).toEqual([{ kind: 'similarity', source: '질문', texts: ['null'] }]);
  });

  it('does nothing without lowLevelAccess, as in RisuAI', async () => {
    const asked: unknown[] = [];
    const result = await runTriggers(
      simInput([checkSimilarity('가§나', '질문'), v2CheckSimilarity(), set('after', '1')], false),
      reversing(asked),
    );
    expect(asked).toEqual([]);
    expect(result.variables['out']).toBeUndefined();
    expect(result.variables['after']).toBe('1');
    expect(result.aborted).toBe(false);
  });

  it('stops the run where the embedder fails, as RisuAI’s throw does, keeping what it wrote before', async () => {
    const steps = [set('before', '1'), checkSimilarity('가§나', '질문'), set('after', '1')];
    const failed = await runTriggers(simInput(steps), { similarity: () => ({ ok: false, error: 'model download failed' }) });
    expect(failed.aborted).toBe(true);
    expect(failed.variables['before']).toBe('1');
    expect(failed.variables['out']).toBeUndefined();
    expect(failed.variables['after']).toBeUndefined();
    expect(failed.log).toContainEqual({ kind: 'error', message: 'checkSimilarity: model download failed' });

    // No one to answer, and a run that cannot wait, fail the same way.
    const unanswered = await runTriggers(simInput([v2CheckSimilarity(), set('after', '1')]));
    expect(unanswered.aborted).toBe(true);
    expect(unanswered.log).toContainEqual({ kind: 'error', message: 'v2CheckSimilarity: embeddings are not available here' });
    const sync = runTriggersSync(simInput([checkSimilarity('가', '나'), set('after', '1')]));
    expect(sync.aborted).toBe(true);
    expect(sync.variables['after']).toBeUndefined();

    // An answer that is not a list of texts is no answer.
    const malformed = await runTriggers(simInput([checkSimilarity('가', '나')]), {
      similarity: () => ({ ok: true, texts: [1, 2] }) as never,
    });
    expect(malformed.aborted).toBe(true);
  });
});

describe('v2 control flow', () => {
  it('takes the else of a false if, and skips it after a true one', () => {
    const block = (hp: string) =>
      runTriggersSync(
        input(
          [
            trigger('start', [
              { type: 'v2If', condition: '>', targetType: 'value', target: '50', source: 'hp', indent: 0 },
              set('state', 'healthy', '=', 'value', 1),
              { type: 'v2EndIndent', indent: 1 },
              { type: 'v2Else', indent: 0 },
              set('state', 'hurt', '=', 'value', 1),
              { type: 'v2EndIndent', indent: 1 },
              set('after', 'yes'),
            ]),
          ],
          { variables: vars({ hp }) },
        ),
      ).variables;
    expect(block('80')['state']).toBe('healthy');
    expect(block('20')['state']).toBe('hurt');
    expect(block('20')['after']).toBe('yes');
  });

  it('compares as numbers whenever both sides read as one', () => {
    const cmp = (condition: string, source: string, target: string) =>
      runTriggersSync(
        input(
          [
            trigger('start', [
              { type: 'v2IfAdvanced', condition, sourceType: 'value', source, targetType: 'value', target, indent: 0 },
              set('hit', '1', '=', 'value', 1),
              { type: 'v2EndIndent', indent: 1 },
            ]),
          ],
        ),
      ).variables['hit'] === '1';
    expect(cmp('=', '1.0', '1')).toBe(true);
    expect(cmp('=', '', '0')).toBe(true);
    expect(cmp('!=', 'a', 'b')).toBe(true);
    expect(cmp('∈', 'b', '["a","b"]')).toBe(true);
    expect(cmp('∉', 'b', 'not json')).toBe(true);
    expect(cmp('∋', 'not json', 'b')).toBe(false);
    expect(cmp('≒', 'Hello World', 'helloworld')).toBe(true);
    expect(cmp('≡', '1', 'true')).toBe(true);
    expect(cmp('≡', 'yes', 'false')).toBe(true);
  });

  it('loops n times, breaks out of an endless loop, and keeps a nested count across outer passes', () => {
    const result = runTriggersSync(
      input([
        trigger('start', [
          { type: 'v2LoopNTimes', value: '3', valueType: 'value', indent: 0 },
          set('outer', '1', '+=', 'value', 1),
          { type: 'v2LoopNTimes', value: '2', valueType: 'value', indent: 1 },
          set('inner', '1', '+=', 'value', 2),
          { type: 'v2EndIndent', indent: 2, endOfLoop: true },
          { type: 'v2EndIndent', indent: 1, endOfLoop: true },
          { type: 'v2Loop', indent: 0 },
          set('spins', '1', '+=', 'value', 1),
          { type: 'v2If', condition: '>=', targetType: 'value', target: '5', source: 'spins', indent: 1 },
          { type: 'v2BreakLoop', indent: 2 },
          { type: 'v2EndIndent', indent: 2 },
          { type: 'v2EndIndent', indent: 1, endOfLoop: true },
        ]),
      ]),
    );
    expect(result.variables['outer']).toBe('3');
    // RisuAI never resets a loop's count: the inner loop runs twice the first
    // time, and once in each later pass.
    expect(result.variables['inner']).toBe('4');
    expect(result.variables['spins']).toBe('5');
  });

  it('stops an endless loop at the step limit, keeping the variables it wrote', () => {
    const result = runTriggersSync(
      input([
        trigger('start', [
          { type: 'v2Loop', indent: 0 },
          set('n', '1', '+=', 'value', 1),
          { type: 'v2EndIndent', indent: 1, endOfLoop: true },
        ]),
      ]),
    );
    expect(result.aborted).toBe(true);
    expect(Number(result.variables['n'])).toBeGreaterThan(MAX_TRIGGER_STEPS / 3);
    expect(result.injections).toEqual({ start: '', historyend: '', promptend: '' });
  });

  it('scopes local variables to their block and shadows the chat’s', () => {
    const result = runTriggersSync(
      input(
        [
          trigger('start', [
            { type: 'v2DeclareLocalVar', var: 'hp', value: '1', valueType: 'value', indent: 0 },
            set('hp', '5', '+='),
            { type: 'v2ConcatString', source1: 'hp', source1Type: 'var', source2: '!', source2Type: 'value', outputVar: 'seen', indent: 0 },
          ]),
        ],
        { variables: vars({ hp: '100' }) },
      ),
    );
    expect(result.variables['hp']).toBe('100');
    expect(result.variables['seen']).toBe('6!');
  });

  it('returns from the run on RisuAI’s early returns, dropping its prompt text', () => {
    const result = runTriggersSync(
      input([
        trigger('start', [
          { type: 'systemprompt', location: 'start', value: 'lost' },
          set('kept', '1'),
          { type: 'v2MakeArrayVar', var: '[bad]', indent: 0 },
          set('never', '1'),
        ]),
      ]),
    );
    expect(result.aborted).toBe(true);
    expect(result.variables['kept']).toBe('1');
    expect(result.variables['never']).toBeUndefined();
    expect(result.injections.start).toBe('');
  });

  it('stops a trigger, and goes on to the next one', () => {
    const result = runTriggersSync(
      input([
        trigger('start', [set('a', '1'), { type: 'v2StopTrigger', indent: 0 }, set('b', '1')]),
        trigger('start', [set('c', '1')]),
      ]),
    );
    expect(result.variables).toEqual(vars({ a: '1', c: '1' }));
  });
});

describe('v2 values', () => {
  const run = (effects: TriggerStep[], variables: Variables = vars()) =>
    runTriggersSync(input([trigger('start', effects)], { variables })).variables;

  it('works arrays and dicts as JSON', () => {
    const out = run([
      { type: 'v2MakeArrayVar', var: 'bag', indent: 0 },
      { type: 'v2PushArrayVar', var: 'bag', value: '검', valueType: 'value', indent: 0 },
      { type: 'v2PushArrayVar', var: 'bag', value: '방패', valueType: 'value', indent: 0 },
      { type: 'v2UnshiftArrayVar', var: 'bag', value: '물약', valueType: 'value', indent: 0 },
      { type: 'v2GetArrayVarLength', var: 'bag', outputVar: 'size', indent: 0 },
      { type: 'v2PopArrayVar', var: 'bag', outputVar: 'popped', indent: 0 },
      { type: 'v2GetIndexOfValueInArrayVar', var: 'bag', value: '검', valueType: 'value', outputVar: 'at', indent: 0 },
      { type: 'v2JoinArrayVar', var: 'bag', varType: 'var', delimiter: '/', delimiterType: 'value', outputVar: 'joined', indent: 0 },
      { type: 'v2MakeDictVar', var: 'stats', indent: 0 },
      { type: 'v2SetDictVar', var: 'stats', varType: 'var', key: 'str', keyType: 'value', value: '7', valueType: 'value', indent: 0 },
      { type: 'v2SetDictVar', var: 'stats', varType: 'var', key: '__proto__', keyType: 'value', value: 'x', valueType: 'value', indent: 0 },
      { type: 'v2GetDictVar', var: 'stats', varType: 'var', key: 'str', keyType: 'value', outputVar: 'str', indent: 0 },
      { type: 'v2HasDictKey', var: 'stats', varType: 'var', key: 'dex', keyType: 'value', outputVar: 'hasDex', indent: 0 },
      { type: 'v2GetDictKeys', var: 'stats', varType: 'var', outputVar: 'keys', indent: 0 },
      { type: 'v2PushArrayVar', var: 'broken', value: 'x', valueType: 'value', indent: 0 },
    ], vars({ broken: 'not json' }));
    expect(out['size']).toBe('3');
    expect(out['popped']).toBe('방패');
    expect(out['bag']).toBe('["물약","검"]');
    expect(out['at']).toBe('1');
    expect(out['joined']).toBe('물약/검');
    expect(out['str']).toBe('7');
    expect(out['hasDex']).toBe('0');
    expect(out['keys']).toBe('["str","__proto__"]');
    expect(out['broken']).toBe('[]');
  });

  it('does strings, regex and RisuAI’s calculator', () => {
    const out = run(
      [
        { type: 'v2ExtractRegex', value: 'HP: 42/100', valueType: 'value', regex: '(\\d+)/(\\d+)', regexType: 'value', flags: '', flagsType: 'value', result: '$2-$1', resultType: 'value', outputVar: 'hp', indent: 0 },
        { type: 'v2RegexTest', value: 'abc', valueType: 'value', regex: '^a', regexType: 'value', flags: '', flagsType: 'value', outputVar: 'test', indent: 0 },
        { type: 'v2RegexTest', value: 'abc', valueType: 'value', regex: '(', regexType: 'value', flags: '', flagsType: 'value', outputVar: 'broken', indent: 0 },
        { type: 'v2ReplaceString', source: 'a1b2', sourceType: 'value', regex: '\\d', regexType: 'value', result: '[$0]', resultType: 'value', replacement: '', replacementType: 'value', flags: 'g', flagsType: 'value', outputVar: 'replaced', indent: 0 },
        { type: 'v2SplitString', source: 'a, b,c', sourceType: 'value', delimiter: '/,\\s*/', delimiterType: 'regex', outputVar: 'split', indent: 0 },
        { type: 'v2GetCharAt', source: '가나다', sourceType: 'value', index: '1', indexType: 'value', outputVar: 'char', indent: 0 },
        { type: 'v2SetCharAt', source: 'abc', sourceType: 'value', index: '5', indexType: 'value', value: 'Z', valueType: 'value', outputVar: 'padded', indent: 0 },
        { type: 'v2ToUpperCase', source: 'abc', sourceType: 'value', outputVar: 'upper', indent: 0 },
        { type: 'v2Calculate', expression: '$hp * 2 + (10 / 4)', expressionType: 'value', outputVar: 'calc', indent: 0 },
        { type: 'v2Calculate', expression: '10 / 3', expressionType: 'value', outputVar: 'third', indent: 0 },
        { type: 'v2Random', min: '1', minType: 'value', max: '6', maxType: 'value', outputVar: 'roll', indent: 0 },
      ],
      vars({ hp: '5' }),
    );
    expect(out['hp']).toBe('100-42');
    expect(out['test']).toBe('1');
    expect(out['broken']).toBe('0');
    expect(out['replaced']).toBe('a[1]b[2]');
    expect(out['split']).toBe('["a","b","c"]');
    expect(out['char']).toBe('나');
    expect(out['padded']).toBe('abcZ');
    expect(out['upper']).toBe('ABC');
    // `$hp` was 5 before the extraction wrote it over, but the calculator reads
    // the variable as it stands, which is no number: 0.
    expect(out['calc']).toBe('202.5');
    expect(out['third']).toBe(String(10 / 3));
    expect(out['roll']).toBe('4');
  });
});

describe('the character, the persona and the lore', () => {
  it('rewrites the description, the global note, the persona and the note, and says which', () => {
    const result = runTriggersSync(
      input([
        trigger('start', [
          { type: 'v2GetCharacterDesc', outputVar: 'before', indent: 0 },
          { type: 'v2SetCharacterDesc', value: '{{getvar::before}} 지금은 기사.', valueType: 'value', indent: 0 },
          { type: 'v2SetReplaceGlobalNote', value: '짧게.', valueType: 'value', indent: 0 },
          { type: 'v2SetPersonaDesc', value: '마법사', valueType: 'value', indent: 0 },
          { type: 'v2SetAuthorNote', value: '비가 온다', valueType: 'value', indent: 0 },
          { type: 'v2GetPersonaDesc', outputVar: 'persona', indent: 0 },
        ]),
      ]),
    );
    expect(result.character).toEqual({ description: '사서. 지금은 기사.', postHistoryInstructions: '짧게.' });
    expect(result.persona).toBe('마법사');
    expect(result.note).toBe('비가 온다');
    expect(result.variables['persona']).toBe('마법사');
  });

  it('reads and rewrites the lorebook in our shape, and leaves the tuple-era effects inert', () => {
    const book = [lore('성', '북쪽의 성.'), lore('숲', '어두운 숲.')];
    const result = runTriggersSync({
      ...input([]),
      character: character(
        [
          trigger('start', [
            { type: 'v2GetLorebookByName', name: '^숲$', nameType: 'value', outputVar: 'found', indent: 0 },
            { type: 'v2GetLorebookByIndex', index: '0', indexType: 'value', outputVar: 'first', indent: 0 },
            { type: 'v2CreateLorebook', name: '탑', nameType: 'value', key: '탑, 마법탑', keyType: 'value', content: '높은 탑.', contentType: 'value', insertOrder: 'x', insertOrderType: 'value', indent: 0 },
            { type: 'v2ModifyLorebookByIndex', index: '0', indexType: 'value', name: '{{slot}}', nameType: 'value', key: '{{slot}},요새', keyType: 'value', content: '{{slot}} 무너졌다.', contentType: 'value', insertOrder: '{{slot}}', insertOrderType: 'value', indent: 0 },
            { type: 'v2DeleteLorebookByIndex', index: '1', indexType: 'value', indent: 0 },
            { type: 'v2SetLorebookAlwaysActive', index: '1', indexType: 'value', value: true, indent: 0 },
            { type: 'v2GetLorebookCountNew', outputVar: 'count', indent: 0 },
            { type: 'v2GetLorebook', target: '성', targetType: 'value', outputVar: 'tuple', indent: 0 },
            { type: 'v2ModifyLorebook', target: '성', targetType: 'value', value: 'x', valueType: 'value', indent: 0 },
          ]),
        ],
        { lorebook: book },
      ),
    });
    expect(result.variables['found']).toBe('[1]');
    expect(result.variables['first']).toBe('북쪽의 성.');
    expect(result.variables['count']).toBe('2');
    expect(result.variables['tuple']).toBe('null');
    expect(result.character.lorebook?.map((entry) => [entry.name, entry.keys, entry.content, entry.insertionOrder, entry.constant])).toEqual([
      ['성', ['성', '요새'], '북쪽의 성. 무너졌다.', 100, false],
      ['탑', ['탑', '마법탑'], '높은 탑.', 100, true],
    ]);
    // The caller's lorebook is not the run's to change.
    expect(book[1]!.name).toBe('숲');
  });
});

describe('display runs', () => {
  it('rewrite the text they are given with the safe subset, and never write the chat', () => {
    const result = runTriggersSync(
      input(
        [
          trigger('display', [
            { type: 'v2GetDisplayState', outputVar: 'text', indent: 0 },
            set('hp', '1', '+='),
            // Not in RisuAI's display allow list, so skipped.
            { type: 'v2ReplaceString', source: 'text', sourceType: 'var', regex: '사과', regexType: 'value', result: '$0', resultType: 'value', replacement: '배', replacementType: 'value', flags: 'g', flagsType: 'value', outputVar: 'text', indent: 0 },
            { type: 'v2ConcatString', source1: 'text', source1Type: 'var', source2: ' (HP {{getvar::hp}})', source2Type: 'value', outputVar: 'text', indent: 0 },
            { type: 'v2SetDisplayState', value: 'text', valueType: 'var', indent: 0 },
            { type: 'v2SetCharacterDesc', value: 'nope', valueType: 'value', indent: 0 },
          ]),
        ],
        { mode: 'display', displayData: '사과를 먹었다', variables: vars({ hp: '3' }) },
      ),
    );
    // The run's own write is its own: the chat's value still reads 3, and the
    // CBS reads the chat's.
    expect(result.displayData).toBe('사과를 먹었다 (HP 3)');
    expect(result.variablesChanged).toBe(false);
    expect(result.variables['hp']).toBe('3');
    expect(result.character).toEqual({});
  });
});

describe('request runs', () => {
  const request = (...turns: [string, string][]): string =>
    JSON.stringify(turns.map(([role, content]) => ({ role, content })));
  const getState = (index: string, outputVar: string, indexType = 'value'): TriggerStep => ({
    type: 'v2GetRequestState', index, indexType, outputVar, indent: 0,
  });
  const setState = (index: string, value: string, valueType = 'value'): TriggerStep => ({
    type: 'v2SetRequestState', index, indexType: 'value', value, valueType, indent: 0,
  });
  const setRole = (index: string, value: string): TriggerStep => ({
    type: 'v2SetRequestStateRole', index, indexType: 'value', value, valueType: 'value', indent: 0,
  });
  const run = (effects: TriggerStep[], extra: Partial<TriggerRunInput> = {}) =>
    runTriggersSync(
      input([trigger('request', effects)], {
        mode: 'request',
        displayData: request(['system', '규칙'], ['user', '안녕'], ['assistant', '어서 와']),
        ...extra,
      }),
    );

  it('skip v1 effects, stop and model calls, as RisuAI’s request allow list does', () => {
    const triggers = [
      trigger('request', [
        { type: 'setvar', var: 'hp', value: '9', operator: '=' },
        { type: 'systemprompt', location: 'start', value: '끼워 넣기' },
        { type: 'impersonate', role: 'user', value: '사칭' },
        { type: 'stop' },
        { type: 'v2StopPromptSending', indent: 0 },
        { type: 'runLLM', value: '물어보기', inputVar: 'answer' },
        { type: 'v2RunLLM', value: '물어보기', valueType: 'value', outputVar: 'answer', model: 'model', indent: 0 },
        { type: 'v2SetCharacterDesc', value: 'nope', valueType: 'value', indent: 0 },
        { type: 'v2GetDisplayState', outputVar: 'shown', indent: 0 },
        setState('1', '{{getvar::hp}}/{{getvar::answer}}'),
      ]),
      // Only the request mode's triggers run.
      trigger('start', [setState('2', 'start')]),
    ];
    const result = runTriggersSync(
      input(triggers, {
        mode: 'request',
        character: character(triggers, { lowLevelAccess: true }),
        displayData: request(['system', '규칙'], ['user', '안녕'], ['assistant', '어서 와']),
        variables: vars({ hp: '3' }),
      }),
    );
    expect(JSON.parse(result.displayData!)).toEqual([
      { role: 'system', content: '규칙' },
      { role: 'user', content: '3/null' },
      { role: 'assistant', content: '어서 와' },
    ]);
    expect(result.aborted).toBe(false);
    expect(result.stopSending).toBe(false);
    expect(result.injections).toEqual({ start: '', historyend: '', promptend: '' });
    expect(result.messages).toEqual(chat('안녕', '어서 와'));
    expect(result.character).toEqual({});
  });

  it('keep what they write to themselves, and read the chat’s values first', () => {
    // A chat value hides the run's own write to it, as the chat state (and the
    // defaults folded into it) comes before RisuAI's tempVars; a fresh name reads
    // back what the run wrote.
    const effects = [
      set('hp', '1', '+='),
      set('fresh', '새 값'),
      setState('1', 'hp', 'var'),
      setState('2', 'fresh', 'var'),
    ];
    const result = run(effects, { variables: vars({ hp: '3' }) });
    expect(JSON.parse(result.displayData!).map((turn: { content: string }) => turn.content)).toEqual(['규칙', '3', '새 값']);
    expect(result.variablesChanged).toBe(false);
    expect(result.variables['hp']).toBe('3');
    expect(result.variables['fresh']).toBeUndefined();
    // Nothing carries over to the next run.
    const again = run([setState('2', 'fresh', 'var')], { variables: vars({ hp: '3' }) });
    expect(JSON.parse(again.displayData!)[2].content).toBe('null');
  });

  it('read and write each turn’s content and role, and count the turns', () => {
    const result = run([
      getState('1', 'said'),
      { type: 'v2GetRequestStateRole', index: '2', indexType: 'value', outputVar: 'role', indent: 0 },
      { type: 'v2GetRequestStateLength', outputVar: 'count', indent: 0 },
      getState('7', 'missing'),
      { type: 'v2GetRequestStateRole', index: '7', indexType: 'value', outputVar: 'missingRole', indent: 0 },
      { type: 'v2ConcatString', source1: 'said', source1Type: 'var', source2: '!', source2Type: 'value', outputVar: 'said', indent: 0 },
      setState('1', 'said', 'var'),
      { type: 'v2ConcatString', source1: 'role', source1Type: 'var', source2: 'missing', source2Type: 'var', outputVar: 'summary', indent: 0 },
      { type: 'v2ConcatString', source1: 'summary', source1Type: 'var', source2: 'count', source2Type: 'var', outputVar: 'summary', indent: 0 },
      { type: 'v2ConcatString', source1: 'summary', source1Type: 'var', source2: 'missingRole', source2Type: 'var', outputVar: 'summary', indent: 0 },
      setState('2', 'summary', 'var'),
      setRole('2', 'system'),
      // Not a role RisuAI takes: ignored, even for a turn that is not there.
      setRole('1', 'narrator'),
      setRole('9', 'tool'),
    ]);
    expect(result.aborted).toBe(false);
    expect(JSON.parse(result.displayData!)).toEqual([
      { role: 'system', content: '규칙' },
      { role: 'user', content: '안녕!' },
      { role: 'system', content: 'assistantnull3null' },
    ]);
  });

  it('end the run on a write to a turn that is not there, dropping the whole edit', () => {
    for (const missing of [setState('3', '없음'), setRole('3', 'user'), setState('{{getvar::nothing}}', '없음')]) {
      const result = run([setState('1', '고침'), missing, setState('2', '뒤')]);
      expect(result.aborted).toBe(true);
      expect(result.displayData).toBeUndefined();
      expect(result.log.map((entry) => entry.kind)).toEqual(['error']);
    }
  });

  it('read a turn past the stored values’ ceiling and write it back, where a display run would stop', () => {
    const long = '가'.repeat(150_000);
    const effects = [
      getState('0', 'system'),
      { type: 'v2ConcatString', source1: 'system', source1Type: 'var', source2: '!', source2Type: 'value', outputVar: 'system', indent: 0 },
      setState('0', 'system', 'var'),
    ];
    const result = run(effects, { displayData: request(['system', long], ['user', '안녕']) });
    expect(result.aborted).toBe(false);
    expect(JSON.parse(result.displayData!)[0].content).toBe(`${long}!`);

    const shown = runTriggersSync(
      input([trigger('display', [set('text', long), { type: 'v2SetDisplayState', value: 'text', valueType: 'var', indent: 0 }])], {
        mode: 'display',
        displayData: '원문',
      }),
    );
    expect(shown.aborted).toBe(true);
    expect(shown.log.map((entry) => entry.kind)).toEqual(['limit']);
  });

  it('return from any other run that reaches them, as RisuAI’s do', () => {
    const result = runTriggersSync(input([trigger('start', [setState('0', 'x'), set('after', '1')])]));
    expect(result.aborted).toBe(true);
    expect(result.variables['after']).toBeUndefined();
  });
});

describe('code triggers', () => {
  it('hand their code to the driver in place, in every mode', async () => {
    const seen: string[] = [];
    const triggers = [
      trigger('start', [set('before', '1')]),
      trigger('manual', [{ type: 'triggerlua', code: 'print(1)' }]),
      trigger('start', [set('after', '1')]),
    ];
    const result = await runTriggers(input(triggers), {
      code: (request) => {
        seen.push(`${request.mode}:${request.code}`);
        request.scope.setVar('fromLua', request.scope.getVar('before'));
        return { stopSending: true };
      },
    });
    expect(seen).toEqual(['start:print(1)']);
    expect(result.variables['fromLua']).toBe('1');
    expect(result.variables['after']).toBe('1');
    expect(result.stopSending).toBe(true);
    // Without an engine the block is simply not run.
    expect(runTriggersSync(input(triggers)).variables['fromLua']).toBeUndefined();
  });

  it('show the code everything it reads up front, and take back what it rewrote', async () => {
    const triggers = [
      trigger('start', [
        set('hp', '3'),
        { type: 'v2DeclareLocalVar', var: 'temp', value: '로컬', valueType: 'value', indent: 0 },
      ]),
      trigger('manual', [{ type: 'triggerlua', code: '' }]),
    ];
    const result = await runTriggers(
      input(triggers, {
        variables: vars({ hp: '1', name: '리안' }),
        globalVariables: vars({ coins: '7' }),
        note: '노트',
        greeting: '첫 인사',
        data: { user: '아린' },
        character: character(triggers, { lorebook: [lore('성', '북쪽')] }),
      }),
      {
        code: ({ scope }) => {
          // A local an earlier trigger of the same run declared is still in reach, as in RisuAI.
          expect({ ...scope.variables() }).toEqual({ hp: '3', name: '리안', temp: '로컬' });
          expect({ ...scope.globalVariables() }).toEqual({ coins: '7' });
          expect(scope.character.name).toBe('리안');
          expect(scope.character.lorebook.map((entry) => entry.content)).toEqual(['북쪽']);
          expect([scope.user, scope.persona, scope.note, scope.greeting]).toEqual(['아린', '여행자', '노트', '첫 인사']);
          scope.setDescription('고쳐 쓴 설명');
          scope.setLorebook([...scope.character.lorebook, lore('탑', '높다')]);
          expect(scope.character.description).toBe('고쳐 쓴 설명');
          scope.messages.splice(0, 1);
        },
      },
    );
    expect(result.character.description).toBe('고쳐 쓴 설명');
    expect(result.character.lorebook?.map((entry) => entry.content)).toEqual(['북쪽', '높다']);
    expect(result.messages.map((message) => message.data)).toEqual(['어서 와']);
  });

  it('take back a name, a first message and a background, and `{{char}}` follows the name where there is no nickname', async () => {
    const run = (extra: Partial<TriggerCharacter>) => {
      const triggers = [
        trigger('start', [{ type: 'triggerlua', code: '' }]),
        trigger('start', [set('who', '{{char}}')]),
      ];
      return runTriggers(input(triggers, { character: character(triggers, extra) }), {
        code: ({ scope }) => {
          expect([scope.character.memberName, scope.character.firstMessage, scope.character.backgroundHtml]).toEqual([
            extra.memberName,
            undefined,
            '<style>.a{}</style>',
          ]);
          scope.setName('세라');
          scope.setFirstMessage('새 인사');
          scope.setBackgroundHtml('<div>밤</div>');
          expect([scope.character.memberName, scope.character.firstMessage, scope.character.backgroundHtml]).toEqual([
            '세라',
            '새 인사',
            '<div>밤</div>',
          ]);
        },
      });
    };
    const plain = await run({ memberName: '리안', backgroundHtml: '<style>.a{}</style>' });
    expect(plain.character).toEqual({ name: '세라', firstMessage: '새 인사', backgroundHtml: '<div>밤</div>' });
    expect(plain.variables['who']).toBe('세라');
    // RisuAI's `{{char}}` is the nickname while there is one, whatever the name under it.
    const nicknamed = await run({ name: '리리', nickname: '리리', memberName: '리안', backgroundHtml: '<style>.a{}</style>' });
    expect(nicknamed.character.name).toBe('세라');
    expect(nicknamed.variables['who']).toBe('리리');
  });
});

describe('CBS in effect fields', () => {
  it('reads the run’s own writes, the chat and the trigger id, and leaves setvar as written', () => {
    const result = runTriggersSync(
      input(
        [
          trigger('manual', [
            set('hp', '10'),
            set('read', '{{getvar::hp}}/{{lastmessage}}/{{trigger_id}}/{{user}}'),
            set('raw', '{{setvar::x::1}}'),
          ], { comment: '확인' }),
        ],
        { mode: 'manual', manualName: '확인', triggerId: 'btn-1', data: { user: '아린' } },
      ),
    );
    expect(result.variables['read']).toBe('10/어서 와/btn-1/아린');
    expect(result.variables['raw']).toBe('{{setvar::x::1}}');
    expect(result.variables['x']).toBeUndefined();
  });

  it('answers the chat functions from the chat as stored, not the run’s copy, for no message of its own', () => {
    const result = runTriggersSync(
      input(
        [
          trigger('start', [
            { type: 'impersonate', role: 'user', value: '흉내' },
            { type: 'v2CutChat', start: '0', startType: 'value', end: '1', endType: 'value', indent: 0 },
            set('last', '{{lastmessage}}/{{lastmessageid}}/{{previouscharchat}}/{{previoususerchat}}/{{previouschatlog::1}}'),
            set('history', '{{history::role}}'),
            set('users', '{{userhistory}}'),
            set('here', '{{chat_index}}/{{messagetime}}/{{messageidleduration}}'),
          ]),
        ],
        { greeting: '어서 오세요' },
      ),
    );
    // The run's own chat is one message by now; RisuAI's macros still read the two stored.
    expect(result.messages.map((message) => message.data)).toEqual(['안녕']);
    expect(result.variables['last']).toBe('어서 와/1/어서 와//어서 와');
    expect(JSON.parse(result.variables['history']!)).toEqual(['user: 안녕', 'char: 어서 와']);
    expect((JSON.parse(result.variables['users']!) as string[]).map((entry) => JSON.parse(entry))).toEqual([
      { role: 'user', data: '안녕' },
    ]);
    // A trigger's text is parsed for no message — RisuAI's index -1 — whatever the chat.
    expect(result.variables['here']).toBe('-1/[Cannot get time]/[Cannot get time]');
  });

  it('reads what a slash command did to the stored chat', () => {
    const result = runTriggersSync(
      input([
        trigger('start', [
          { type: 'command', value: '/send 명령' },
          set('last', '{{lastmessage}}'),
        ]),
      ]),
    );
    expect(result.variables['last']).toBe('명령');
    // The run's own copy is what it leaves, as RisuAI writes it over the stored chat.
    expect(result.messages.map((message) => message.data)).toEqual(['안녕', '어서 와']);
  });
});

describe('risuCalculate', () => {
  it('matches RisuAI’s precedence and quirks', () => {
    expect(risuCalculate('1+2*3')).toBe(7);
    expect(risuCalculate('(1+2)*3')).toBe(9);
    expect(risuCalculate('2^3^2')).toBe(64);
    expect(risuCalculate('-3+5')).toBe(2);
    expect(risuCalculate('5>3')).toBe(1);
    expect(risuCalculate('1 == 1')).toBe(1);
    expect(risuCalculate('$x+1', (name) => (name === 'x' ? '4' : undefined))).toBe(5);
    expect(risuCalculate('null+2')).toBe(2);
  });
});

describe('the overlay', () => {
  it('merges field by field and lays itself over a card', () => {
    const first = mergeScriptOverlay(null, { members: { a: { description: 'one' } } });
    const second = mergeScriptOverlay(first, { members: { a: { lorebook: [] }, b: { description: 'two' } }, persona: 'p' });
    expect(second).toEqual({
      members: { a: { description: 'one', lorebook: [] }, b: { description: 'two' } },
      persona: 'p',
    });
    expect(mergeScriptOverlay(null, {})).toBeNull();
    const card = { description: 'base', lorebook: [lore('x', 'y')], postHistoryInstructions: 'n' };
    expect(overlaidCard(card, second!.members!['a'])).toEqual({ description: 'one', lorebook: [], postHistoryInstructions: 'n' });
    expect(overlaidCard(card, undefined)).toBe(card);
  });

  it('keeps a name, a first message and a background field by field, the name one trimmed line', () => {
    const first = mergeScriptOverlay(null, { members: { a: { name: '세라', firstMessage: '안녕' } } });
    const second = mergeScriptOverlay(first, { members: { a: { backgroundHtml: '<div>밤</div>', firstMessage: '' } } });
    expect(second).toEqual({ members: { a: { name: '세라', firstMessage: '', backgroundHtml: '<div>밤</div>' } } });
    // The card is not where a name or a greeting lives: those are the member's and the chat's.
    expect(overlaidCard({ description: 'd', lorebook: [], postHistoryInstructions: '' }, second!.members!['a'])).toEqual({
      description: 'd',
      lorebook: [],
      postHistoryInstructions: '',
    });
    expect(overlayName('  세라  ')).toBe('세라');
    expect(overlayName('x'.repeat(MAX_OVERLAY_NAME_LENGTH))).toBe('x'.repeat(MAX_OVERLAY_NAME_LENGTH));
    for (const bad of ['', '   ', 'x'.repeat(MAX_OVERLAY_NAME_LENGTH + 1), '세\n라', '세\t라']) expect(overlayName(bad), bad).toBeNull();
  });
});

describe('the chat a run leaves', () => {
  const chat: TriggerMessage[] = [
    { role: 'user', data: '안녕', id: 'm0' },
    { role: 'char', data: '어서 와', id: 'm1' },
    { role: 'user', data: '들어간다', id: 'm2' },
  ];
  const turn: TriggerMessage = { role: 'user', data: '또', id: 'turn' };

  it('says what a run kept, changed and added, against the chat it was given', () => {
    expect(scriptChatOf(chat, chat.map((message) => ({ ...message })))).toBeNull();
    expect(scriptChatOf(chat, [...chat, { role: 'char', data: '덧붙임' }])).toEqual({
      keep: 3,
      messages: [{ role: 'assistant', content: '덧붙임' }],
    });
    expect(scriptChatOf(chat, chat.slice(0, 1))).toEqual({ keep: 1, messages: [] });
    expect(scriptChatOf(chat, [chat[0]!, { ...chat[1]!, data: '고침', role: 'user' }, chat[2]!])).toEqual({
      keep: 1,
      messages: [{ id: 'm1', role: 'user', content: '고침' }, { id: 'm2' }],
    });
    // A message moved out of branch order, or named twice, goes as a new one with its text.
    expect(scriptChatOf(chat, [chat[1]!, chat[0]!, chat[1]!])).toEqual({
      keep: 0,
      messages: [{ id: 'm1' }, { role: 'user', content: '안녕' }, { role: 'assistant', content: '어서 와' }],
    });
  });

  it('places a send’s turn, and reads it at the end as the chat as it was', () => {
    expect(scriptChatOf([...chat, turn], [...chat, { ...turn, data: '바뀐 말' }], 'turn')).toBeNull();
    expect(scriptChatOf([...chat, turn], [...chat, turn, { role: 'char', data: '독백' }], 'turn')).toEqual({
      keep: 3,
      messages: [{ turn: true }, { role: 'assistant', content: '독백' }],
    });
    expect(scriptChatOf([...chat, turn], chat, 'turn')).toEqual({ keep: 3, messages: [] });
  });

  it('checks a result’s shape and size, the turn only where one may stand', () => {
    expect(checkScriptChat(undefined)).toEqual({ ok: true, chat: null });
    expect(checkScriptChat({ messages: [{ id: 'm1' }, { role: 'user', content: '' }] })).toEqual({
      ok: true,
      chat: { keep: 0, messages: [{ id: 'm1' }, { role: 'user', content: '' }] },
    });
    for (const value of [
      [],
      { keep: 1.5, messages: [] },
      { keep: 0 },
      { messages: [{ role: 'system', content: 'x' }] },
      { messages: [{ role: 'user' }] },
      { messages: [{ id: 3 }] },
      { messages: [{ role: 'user', content: 'a\u0000b' }] },
      { messages: [{ turn: true }] },
    ]) {
      expect(checkScriptChat(value), JSON.stringify(value)).toMatchObject({ ok: false, limit: false });
    }
    expect(checkScriptChat({ messages: [{ turn: true }, { turn: true }] }, { turn: true })).toMatchObject({ ok: false });
    expect(checkScriptChat({ messages: [{ role: 'user', content: 'x'.repeat(MAX_SCRIPT_CHAT_TEXT + 1) }] })).toMatchObject({
      ok: false,
      limit: true,
    });
  });
});

describe('the classification', () => {
  it('names every effect the interpreter has a case for, and nothing it has not', () => {
    const whole = readFileSync(new URL('../src/triggers/interpreter.ts', import.meta.url), 'utf8');
    // The effect switch is the one in `runOnce`; the helpers after it switch on operators.
    const source = whole.slice(whole.indexOf('function* runOnce'), whole.indexOf('/* ---------------------------------------------------------------- helpers */'));
    const cases = new Set([...source.matchAll(/case '([A-Za-z0-9]+)':/g)].map((match) => match[1]!));
    const effects = [...cases];
    for (const effect of effects) expect(TRIGGER_CLASSIFICATION[effect], effect).toBeDefined();
    const classified = Object.keys(TRIGGER_CLASSIFICATION).filter((name) => !name.includes(':'));
    for (const name of classified) {
      if (name === 'triggercode') continue;
      expect(cases.has(name), name).toBe(true);
    }
  });
});

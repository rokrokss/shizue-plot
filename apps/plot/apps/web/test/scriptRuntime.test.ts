/**
 * The chat's script runtime against a fake API: what each moment of a turn sends
 * to the server, and that every delta it sends folds back, on the server's side,
 * to the state the scripts ended in.
 */
import { applyVariableDelta, computeVariables, emptyVariables, type Variables } from '@shizue/core/variables';
import { MAX_SCRIPT_CHAT_MESSAGES, type TriggerScript, type TriggerStep } from '@shizue/core/triggers';
import { describe, expect, it } from 'vitest';
import { loadWholeBranch } from '../src/lib/scripts/branch';
import type { ScriptEngine } from '../src/lib/scripts/engine';
import { createScriptRuntime, type ScriptBundle, type ScriptUi, type ScriptView } from '../src/lib/scripts/runtime';
import type { ChatMessage, ChatState } from '../src/lib/types';

const vars = (entries: Record<string, string> = {}): Variables => Object.assign(emptyVariables(), entries);

const message = (
  id: string,
  parentId: string | null,
  role: ChatMessage['role'],
  content: string,
  extra: Partial<ChatMessage> = {},
): ChatMessage => ({
  id,
  parentId,
  role,
  content,
  source: 'user',
  directions: null,
  model: null,
  promptTokens: null,
  completionTokens: null,
  attachments: [],
  createdAt: '2026-10-13T00:00:00.000Z',
  ...extra,
});

const trigger = (type: TriggerScript['type'], effect: TriggerStep[], extra: Partial<TriggerScript> = {}): TriggerScript => ({
  comment: '',
  type,
  conditions: [],
  effect,
  ...extra,
});

const setvar = (variable: string, value: string, operator = '='): TriggerStep => ({
  type: 'v2SetVar',
  var: variable,
  value,
  operator,
  valueType: 'value',
  indent: 0,
});

function bundle(extra: Partial<ScriptBundle> = {}): ScriptBundle {
  return {
    memberId: '00000000-0000-4000-8000-000000000001',
    name: '리안',
    triggers: [],
    editScripts: [],
    lowLevelAccess: false,
    character: {
      description: '사서.',
      personality: '',
      scenario: '',
      exampleDialogue: '',
      lorebook: [],
      postHistoryInstructions: '',
    },
    overlay: { member: null, persona: null },
    ...extra,
  };
}

/** Records every request and answers with a state built from the body. */
function fakeApi(answer: (path: string, body: Record<string, unknown>) => ChatState = () => ({}) as ChatState) {
  const calls: { method: string; path: string; body: Record<string, unknown> }[] = [];
  return {
    calls,
    api: {
      send: async <T,>(method: string, path: string, body?: unknown): Promise<T> => {
        calls.push({ method, path, body: (body ?? {}) as Record<string, unknown> });
        return answer(path, (body ?? {}) as Record<string, unknown>) as T;
      },
    },
  };
}

const silentUi: ScriptUi = {
  alert: async () => undefined,
  input: async () => '',
  select: async (options) => options[0] ?? '',
  confirm: async () => false,
};

const defaults = vars({ hp: '100' });
const names = { user: '아린', char: '여관' };

const view = (messages: ChatMessage[], extra: Partial<ScriptView> = {}): ScriptView => ({
  messages,
  defaults,
  names,
  note: '',
  persona: '여행자',
  ...extra,
});

/** What the server folds a stored branch to: macros, then each message's delta. */
const serverFold = (messages: { content: string; variableDelta?: Record<string, string | null> | null }[]): Variables =>
  computeVariables(messages, defaults, names);

const greeting = message('m0', null, 'assistant', '어서 와.');
const reply = message('m2', 'm1', 'assistant', '{{setvar::hp::90}}다친 것 같다.', {
  scriptState: 'pending',
  scriptRev: 0,
  variableDelta: { mood: 'tense' },
});
const branch = [greeting, message('m1', 'm0', 'user', '들어간다'), reply];

describe('prepare: a send', () => {
  it('runs the input triggers, the input scripts and the start triggers, and sends what folds back to their end', async () => {
    const { api, calls } = fakeApi();
    const runtime = createScriptRuntime({
      chatId: 'c1',
      api,
      ui: silentUi,
      bundle: bundle({
        triggers: [
          trigger('input', [setvar('seenInput', '{{lastmessage}}')]),
          trigger('start', [
            setvar('hp', '5', '-='),
            { type: 'v2GetLastMessage', outputVar: 'sentAs', indent: 0 },
            { type: 'v2SystemPrompt', location: 'historyend', value: 'HP {{getvar::hp}}', valueType: 'value', indent: 0 },
          ]),
        ],
        editScripts: [{ type: 'editinput', in: '안녕', out: '안녕하세요' }],
      }),
    });
    const messages = [greeting, message('m1', 'm0', 'user', '앉는다'), message('m2', 'm1', 'assistant', '응.')];
    const prepared = await runtime.prepare('send', view(messages), '안녕 {{addvar::hp::1}}');

    expect(prepared.stop).toBe(false);
    expect(prepared.content).toBe('안녕하세요 {{addvar::hp::1}}');
    expect(prepared.body).toMatchObject({
      baseHeadId: 'm2',
      injections: { historyend: 'HP 96\n\n' },
    });
    expect(prepared.body['postProcess']).toBeUndefined();
    // Stored on the turn, the delta folds back to where the scripts ended.
    const stored = { content: prepared.content!, variableDelta: prepared.body['variableDelta'] as Record<string, string> };
    expect(serverFold([...messages, stored])).toEqual(
      vars({ hp: '96', seenInput: '응.', sentAs: '안녕하세요 {{addvar::hp::1}}' }),
    );
    // Nothing needed committing first.
    expect(calls).toEqual([]);
  });

  it('asks for post-processing when the plot has output scripts, and stops on a start trigger’s stop', async () => {
    const { api } = fakeApi();
    const runtime = createScriptRuntime({
      chatId: 'c1',
      api,
      ui: silentUi,
      bundle: bundle({
        triggers: [
          trigger('output', [setvar('x', '1')]),
          trigger('start', [{ type: 'stop' }], {
            conditions: [{ type: 'exists', type2: 'loose', value: '/roll', depth: 1 }],
          }),
        ],
      }),
    });
    expect(runtime.finishesReplies).toBe(true);
    const normal = await runtime.prepare('send', view([greeting]), '안녕');
    expect(normal.body).toMatchObject({ postProcess: true, baseHeadId: 'm0' });
    const stopped = await runtime.prepare('send', view([greeting]), '/roll 2d6');
    expect(stopped.stop).toBe(true);
    // The turn is still stored, but there is no reply for the output scripts to finish.
    expect(stopped.content).toBe('/roll 2d6');
    expect(stopped.body).toEqual({ baseHeadId: 'm0' });
  });

  it('carries a start trigger’s rewrite of the head on the generation, and the overlay once accepted', async () => {
    const { api, calls } = fakeApi(() => ({ marker: 'rewritten' }) as unknown as ChatState);
    const runtime = createScriptRuntime({
      chatId: 'c1',
      api,
      ui: silentUi,
      bundle: bundle({
        triggers: [
          trigger('start', [
            { type: 'v2ModifyChat', index: '0', indexType: 'value', value: '고친 인사', valueType: 'value', indent: 0 },
            { type: 'v2SetCharacterDesc', value: '{{description}} 지금은 기사.', valueType: 'value', indent: 0 },
            { type: 'v2SetAuthorNote', value: '비', valueType: 'value', indent: 0 },
          ]),
        ],
      }),
    });
    const head = message('m1', null, 'assistant', '인사', { scriptRev: 2 });
    // The opening here is not the root greeting's place: a message after it is the head.
    const messages = [greeting, { ...head, parentId: 'm0' }];
    const prepared = await runtime.prepare('regenerate', view(messages));
    // A regenerate's branch stops before the head it replaces: there is no index 0 to rewrite.
    expect(prepared.body['chat']).toBeUndefined();
    const auto = await runtime.prepare('auto', view(messages));
    // The rewrite rides on the generation, which keeps it before the prompt is
    // built: nothing is committed first.
    expect(calls).toEqual([]);
    expect(auto.state).toBeUndefined();
    expect(auto.body).toMatchObject({
      chat: { keep: 0, messages: [{ id: 'm1', content: '고친 인사' }] },
      overlay: { members: { '00000000-0000-4000-8000-000000000001': { description: '사서. 지금은 기사.' } } },
      note: '비',
    });
    // Until the server takes a generation, the runtime's copy does not move…
    const again = await runtime.prepare('auto', view(messages));
    expect((again.body['overlay'] as { members: Record<string, { description: string }> }).members['00000000-0000-4000-8000-000000000001']!.description).toBe(
      '사서. 지금은 기사.',
    );
    // …and once it has, the next run reads the rewrite.
    again.accept();
    const third = await runtime.prepare('auto', view(messages));
    expect((third.body['overlay'] as { members: Record<string, { description: string }> }).members['00000000-0000-4000-8000-000000000001']!.description).toBe(
      '사서. 지금은 기사. 지금은 기사.',
    );
    expect(prepared.stop).toBe(false);
  });
});

describe('prepare: the other generations', () => {
  it('runs the start triggers on the branch the generation reads, and sends their writes as startDelta', async () => {
    const { api } = fakeApi();
    const runtime = createScriptRuntime({
      chatId: 'c1',
      api,
      ui: silentUi,
      bundle: bundle({ triggers: [trigger('start', [{ type: 'v2GetMessageCount', outputVar: 'count', indent: 0 }])] }),
    });
    const messages = [greeting, message('m1', 'm0', 'user', '{{setvar::hp::50}}'), message('m2', 'm1', 'assistant', '{{setvar::hp::1}}')];
    // A regenerate replaces the head: the triggers see one message, and its fold.
    const regenerate = await runtime.prepare('regenerate', view(messages));
    expect(regenerate.body['startDelta']).toEqual({ count: '1' });
    expect(applyVariableDelta(serverFold(messages.slice(0, -1)), regenerate.body['startDelta'] as Record<string, string>)).toEqual(
      vars({ hp: '50', count: '1' }),
    );
    const cont = await runtime.prepare('continue', view(messages));
    expect(cont.body['startDelta']).toEqual({ count: '2' });
  });

  it('sends only the head check when nothing runs before a generation', async () => {
    const runtime = createScriptRuntime({ chatId: 'c1', api: fakeApi().api, ui: silentUi, bundle: bundle() });
    expect((await runtime.prepare('narrate', view([greeting]))).body).toEqual({ baseHeadId: 'm0' });
  });
});

describe('finish', () => {
  it('rewrites the pending reply, runs the output triggers, and commits a delta that replaces the server’s', async () => {
    const { api, calls } = fakeApi();
    const runtime = createScriptRuntime({
      chatId: 'c1',
      api,
      ui: silentUi,
      bundle: bundle({
        triggers: [
          trigger('output', [
            setvar('hp', '10', '-='),
            { type: 'v2GetLastMessage', outputVar: 'last', indent: 0 },
          ]),
        ],
        editScripts: [{ type: 'editoutput', in: '다친 것 같다', out: '다쳤다 (HP {{getvar::hp}})' }],
      }),
    });
    const done = await runtime.finish(view(branch));
    expect(done?.followUp).toBe(false);
    expect(calls).toHaveLength(1);
    const body = calls[0]!.body;
    expect(body).toMatchObject({
      messageId: 'm2',
      scriptRev: 0,
      clearPending: true,
      content: '{{setvar::hp::90}}다쳤다 (HP 90).',
    });
    // Stored with the new text and the new delta, the reply folds to where the
    // output triggers ended — the start triggers' mood included.
    const stored = [...branch.slice(0, -1), { content: body['content'] as string, variableDelta: body['variableDelta'] as Record<string, string> }];
    expect(serverFold(stored)).toEqual(vars({ hp: '80', mood: 'tense', last: '{{setvar::hp::90}}다쳤다 (HP 90).' }));
  });

  it('does nothing for a head that is not pending, and still clears one when no script is left to run', async () => {
    const { api, calls } = fakeApi();
    const runtime = createScriptRuntime({ chatId: 'c1', api, ui: silentUi, bundle: bundle() });
    expect(await runtime.finish(view([greeting]))).toBeNull();
    await runtime.finish(view(branch));
    expect(calls[0]!.body).toMatchObject({ clearPending: true, variableDelta: { mood: 'tense' } });
    expect(calls[0]!.body['content']).toBeUndefined();
  });

  it('keeps an output trigger’s rewrite of the reply, and passes a low-level follow-up on', async () => {
    const { api, calls } = fakeApi();
    const runtime = createScriptRuntime({
      chatId: 'c1',
      api,
      ui: silentUi,
      bundle: bundle({
        lowLevelAccess: true,
        triggers: [
          trigger('output', [
            { type: 'v2ModifyChat', index: '{{lastmessageid}}', indexType: 'value', value: '바뀐 대답', valueType: 'value', indent: 0 },
            { type: 'sendAIprompt' },
          ]),
        ],
      }),
    });
    const done = await runtime.finish(view(branch));
    expect(done?.followUp).toBe(true);
    expect(calls[0]!.body['content']).toBe('바뀐 대답');
  });
});

describe('manual', () => {
  it('runs the named trigger and commits its writes on the head, with the trigger id', async () => {
    const { api, calls } = fakeApi();
    const runtime = createScriptRuntime({
      chatId: 'c1',
      api,
      ui: silentUi,
      bundle: bundle({
        triggers: [trigger('manual', [setvar('clicked', '{{trigger_id}}'), setvar('hp', '1', '+=')], { comment: '공격' })],
      }),
    });
    expect([...runtime.triggerNames]).toEqual(['공격']);
    const done = [greeting, message('m1', 'm0', 'user', '{{setvar::hp::50}}')];
    await runtime.manual('공격', 'btn-7', view(done));
    expect(calls[0]!.body).toMatchObject({ messageId: 'm1', scriptRev: 0, variableDelta: { clicked: 'btn-7', hp: '51' } });
    const stored = [greeting, { content: done[1]!.content, variableDelta: calls[0]!.body['variableDelta'] as Record<string, string> }];
    expect(serverFold(stored)).toEqual(vars({ hp: '51', clicked: 'btn-7' }));
    // A name no trigger has commits nothing.
    expect(await runtime.manual('없음', null, view(done))).toBeNull();
    expect(calls).toHaveLength(1);
  });

  it('asks the model through script-llm for a runLLM, and writes a refusal as RisuAI does', async () => {
    const forecast = bundle({
      lowLevelAccess: true,
      triggers: [trigger('manual', [{ type: 'runLLM', value: '날씨?', inputVar: 'weather' }], { comment: '예보' })],
    });
    const done = [greeting, message('m1', 'm0', 'user', '밖은?')];

    const { api, calls } = fakeApi((path) =>
      (path.endsWith('/script-llm') ? { result: '맑음' } : {}) as unknown as ChatState,
    );
    await createScriptRuntime({ chatId: 'c1', api, ui: silentUi, bundle: forecast }).manual('예보', null, view(done));
    expect(calls[0]).toEqual({
      method: 'POST',
      path: '/api/chats/c1/script-llm',
      body: { messages: [{ role: 'user', content: '날씨?' }], model: 'main' },
    });
    expect(calls[1]!.body).toMatchObject({ messageId: 'm1', variableDelta: { weather: '맑음' } });

    // A refused call (no lowLevelAccess on the server's side, a busy chat) is the failure the effect writes.
    const refused = fakeApi();
    const refusing = {
      send: async <T,>(method: string, path: string, body?: unknown): Promise<T> => {
        if (path.endsWith('/script-llm')) throw new Error('script_llm_forbidden');
        return refused.api.send<T>(method, path, body);
      },
    };
    await createScriptRuntime({ chatId: 'c1', api: refusing, ui: silentUi, bundle: forecast }).manual('예보', null, view(done));
    expect(refused.calls[0]!.body).toMatchObject({ variableDelta: { weather: 'Error: script_llm_forbidden' } });
  });

  it("asks for the chat's auxiliary model where a v2RunLLM names RisuAI's sub model, and the main one otherwise", async () => {
    const step = (model: string, outputVar: string): TriggerStep => ({
      type: 'v2RunLLM',
      value: '날씨?',
      valueType: 'value',
      model,
      outputVar,
      indent: 0,
    });
    const forecast = bundle({
      lowLevelAccess: true,
      triggers: [trigger('manual', [step('submodel', 'side'), step('model', 'main')], { comment: '예보' })],
    });
    const { api, calls } = fakeApi((path, body) =>
      (path.endsWith('/script-llm') ? { result: `${String(body['model'])} 답` } : {}) as unknown as ChatState,
    );
    await createScriptRuntime({ chatId: 'c1', api, ui: silentUi, bundle: forecast }).manual(
      '예보',
      null,
      view([greeting, message('m1', 'm0', 'user', '밖은?')]),
    );
    expect(calls.filter((call) => call.path.endsWith('/script-llm')).map((call) => call.body['model'])).toEqual(['sub', 'main']);
    expect(calls.at(-1)!.body).toMatchObject({ variableDelta: { side: 'sub 답', main: 'main 답' } });
  });

  it('answers checkSimilarity with the page’s search, and stops the run where the search fails, as RisuAI’s throw does', async () => {
    const search = bundle({
      lowLevelAccess: true,
      triggers: [
        trigger(
          'manual',
          [{ type: 'checkSimilarity', value: '불§물§바람', source: '{{getvar::element}}', inputVar: 'ranked' }, setvar('after', '1')],
          { comment: '찾기' },
        ),
      ],
    });
    const done = [greeting, message('m1', 'm0', 'user', '물?', { variableDelta: { element: '물' } })];

    const asked: [string, readonly string[]][] = [];
    const { api, calls } = fakeApi();
    await createScriptRuntime({
      chatId: 'c1',
      api,
      ui: silentUi,
      bundle: search,
      similarity: async (source, texts) => (asked.push([source, texts]), [...texts].reverse()),
    }).manual('찾기', null, view(done));
    expect(asked).toEqual([['물', ['불', '물', '바람']]]);
    expect(calls[0]!.body).toMatchObject({ messageId: 'm1', variableDelta: { ranked: '바람§물§불', after: '1' } });

    const logs: unknown[] = [];
    const failed = fakeApi();
    await createScriptRuntime({
      chatId: 'c1',
      api: failed.api,
      ui: silentUi,
      bundle: search,
      similarity: async () => {
        throw new Error('the model could not be fetched');
      },
      log: (entry) => logs.push(entry),
    }).manual('찾기', null, view(done));
    expect(logs).toContainEqual({ kind: 'error', message: 'checkSimilarity: the model could not be fetched' });
    expect(JSON.stringify(failed.calls)).not.toMatch(/ranked|after/);
  });

  it('asks the reader through the page, and commits the answer', async () => {
    const { api, calls } = fakeApi();
    const asked: string[] = [];
    const runtime = createScriptRuntime({
      chatId: 'c1',
      api,
      ui: { ...silentUi, input: async (text) => (asked.push(text), '아린') },
      bundle: bundle({
        triggers: [
          trigger('manual', [{ type: 'v2GetAlertInput', display: '이름은?', displayType: 'value', outputVar: 'name', indent: 0 }], {
            comment: '이름',
          }),
        ],
      }),
    });
    await runtime.manual('이름', null, view([greeting]));
    expect(asked).toEqual(['이름은?']);
    expect(calls[0]!.body['variableDelta']).toEqual({ name: '아린' });
  });
});

describe('display', () => {
  it('rewrites the text the display triggers are given, without touching the chat', () => {
    const runtime = createScriptRuntime({
      chatId: 'c1',
      api: fakeApi().api,
      ui: silentUi,
      bundle: bundle({
        triggers: [
          trigger('display', [
            { type: 'v2GetDisplayState', outputVar: 'text', indent: 0 },
            { type: 'v2ConcatString', source1: 'text', source1Type: 'var', source2: ' ♥', source2Type: 'value', outputVar: 'text', indent: 0 },
            { type: 'v2SetDisplayState', value: 'text', valueType: 'var', indent: 0 },
          ]),
        ],
      }),
    });
    expect(runtime.rewritesDisplay).toBe(true);
    expect(runtime.display('안녕', view([greeting]), vars())).toBe('안녕 ♥');
  });
});

describe('the Lua seat', () => {
  it('logs a risu-btn and a Lua trigger with no engine, and hands them to one that is installed', async () => {
    const logged: string[] = [];
    const lua = [trigger('start', [{ type: 'triggerlua', code: 'x' }])];
    const without = createScriptRuntime({
      chatId: 'c1',
      api: fakeApi().api,
      ui: silentUi,
      bundle: bundle({ triggers: lua }),
      log: (entry) => logged.push(entry.effect ?? entry.kind),
    });
    // A plot whose only scripts are Lua finishes no replies without the engine.
    expect(without.finishesReplies).toBe(false);
    expect(await without.button('data', view([greeting]))).toBeNull();
    expect(logged).toEqual(['risu-btn']);

    const seen: string[] = [];
    const { api, calls } = fakeApi(() => ({ variables: { visits: '4', old: 'x' } }) as unknown as ChatState);
    const globals: Variables[] = [];
    const withEngine = createScriptRuntime({
      chatId: 'c1',
      api,
      ui: silentUi,
      bundle: bundle({ triggers: lua }),
      onGlobalVariables: (variables) => void globals.push(variables),
      engines: [
        {
          name: 'lua',
          handles: () => true,
          runCode: async (request) => {
            seen.push(request.mode);
            request.scope.setVar('fromLua', '1');
            // Lua's setGlobalVar: the reader's, not the branch's.
            request.scope.setGlobalVar('visits', String(Number(request.scope.getGlobalVar('visits')) + 1));
            request.scope.setGlobalVar('gone', null);
          },
          button: async (data) => void seen.push(`button:${data}`),
        },
      ],
    });
    const prepared = await withEngine.prepare('auto', view([greeting], { globalVariables: vars({ visits: '3' }) }));
    // A button that wrote nothing has nothing to commit.
    expect(await withEngine.button('go', view([greeting]))).toBeNull();
    expect(seen).toEqual(['start', 'button:go']);
    expect(prepared.body['startDelta']).toEqual({ fromLua: '1' });
    expect(calls).toEqual([
      { method: 'PATCH', path: '/api/chats/c1/global-variables', body: { variables: { visits: '4', gone: null } } },
    ]);
    expect(globals).toEqual([{ visits: '4', old: 'x' }]);
  });
});

describe('an engine outside a trigger run', () => {
  /** An engine whose hooks write through the scope they are handed, as the Lua engine does. */
  const writer = (): ScriptEngine => ({
    name: 'lua',
    handles: (phase) => phase !== 'start' && phase !== 'output' && phase !== 'input',
    edit: async (phase, text, meta, scope) => {
      scope.setVar(phase, `${scope.getVar('hp')}@${meta.chatIndex}`);
      return `${text}+${phase}`;
    },
    display: async (items, scope) => items.map((item) => `${item.text}|${scope.getVar('hp')}|${item.chatIndex}`),
    button: async (data, scope) => {
      scope.setVar('pressed', data);
      scope.setDescription('버튼이 바꾼 설명');
      scope.messages.at(-1)!.data = '버튼이 고친 답';
    },
    manualNames: () => ['attack'],
  });
  const lua = [trigger('start', [{ type: 'triggerlua', code: 'x' }])];

  it('folds what an input listener wrote into the turn, and an output listener’s into the reply', async () => {
    const { api, calls } = fakeApi();
    const runtime = createScriptRuntime({ chatId: 'c1', api, ui: silentUi, bundle: bundle({ triggers: lua }), engines: [writer()] });
    expect(runtime.finishesReplies).toBe(true);
    expect(runtime.triggerNames.has('attack')).toBe(true);
    const sent = await runtime.prepare('send', view([greeting]), '안녕');
    expect(sent.content).toBe('안녕+editinput');
    expect(sent.body['variableDelta']).toEqual({ editinput: '100@-1' });

    await runtime.finish(view(branch));
    const commit = calls.find((call) => call.path.endsWith('/script-commit'))!;
    expect(commit.body['content']).toBe('{{setvar::hp::90}}다친 것 같다.+editoutput');
    // Against what the server folds the stored reply to: its macros, and nothing of the old delta.
    const plain = serverFold([greeting, branch[1]!, { content: commit.body['content'] as string }]);
    const folded = serverFold([greeting, branch[1]!, { content: commit.body['content'] as string, variableDelta: commit.body['variableDelta'] as Record<string, string | null> }]);
    expect(plain['hp']).toBe('90');
    expect(folded['editoutput']).toBe('90@1');
    expect(folded['mood']).toBe('tense');
  });

  it('keeps what an output listener did to the chat: the reply’s place takes its text, and the output triggers read that chat', async () => {
    const { api, calls } = fakeApi();
    const listener: ScriptEngine = {
      name: 'lua',
      handles: (phase) => phase === 'editoutput',
      edit: async (_phase, text, _meta, scope) => {
        scope.messages[0]!.data = '고쳐 쓴 말';
        scope.messages.push({ role: 'char', data: '덧붙임' });
        // The reply's own place is written over with what it came to, as RisuAI's is.
        scope.messages[1]!.data = '사라질 글';
        return `${text}!`;
      },
    };
    const runtime = createScriptRuntime({
      chatId: 'c1',
      api,
      ui: silentUi,
      bundle: bundle({ triggers: [trigger('output', [setvar('seen', '{{lastmessage}}'), setvar('at', '{{lastmessageid}}')])] }),
      engines: [listener],
    });
    await runtime.finish(view(branch));
    const commit = calls.find((call) => call.path.endsWith('/script-commit'))!;
    expect(commit.body).toMatchObject({
      messageId: 'm2',
      clearPending: true,
      content: '{{setvar::hp::90}}다친 것 같다.!',
      chat: { keep: 0, messages: [{ id: 'm1', content: '고쳐 쓴 말' }, { id: 'm2' }, { role: 'assistant', content: '덧붙임' }] },
    });
    // The delta is the message the chat now ends on, which the output triggers read the chat to.
    expect(commit.body['variableDelta']).toMatchObject({ seen: '덧붙임', at: '2' });
  });

  it('drops what an input listener did to the chat, which RisuAI writes the input run’s chat over — unless that run ended early', async () => {
    const intruder: ScriptEngine = {
      name: 'lua',
      handles: (phase) => phase === 'editinput',
      edit: async (_phase, text, _meta, scope) => {
        scope.messages.push({ role: 'char', data: '끼어듦' });
        return text;
      },
    };
    const messages = [greeting, message('m1', 'm0', 'user', '앉는다'), message('m2', 'm1', 'assistant', '응.')];
    const send = async (input: TriggerStep[]) => {
      const logged: string[] = [];
      const runtime = createScriptRuntime({
        chatId: 'c1',
        api: fakeApi().api,
        ui: silentUi,
        bundle: bundle({ triggers: [trigger('input', input)] }),
        engines: [intruder],
        log: (entry) => void logged.push(`${entry.kind}:${entry.effect ?? ''}`),
      });
      return { prepared: await runtime.prepare('send', view(messages), '안녕'), logged };
    };
    const completed = await send([setvar('a', '1')]);
    expect(completed.prepared.body['chat']).toBeUndefined();
    expect(completed.logged).toContain('dropped:editinput');
    // A run that returned early hands back nothing: the turn goes onto the chat as stored, the listener's write with it.
    const ended = await send([{ type: 'v2GetDisplayState', outputVar: 'x', indent: 0 }]);
    expect(ended.prepared.body['chat']).toEqual({ keep: 2, messages: [{ role: 'assistant', content: '끼어듦' }, { turn: true }] });
  });

  it('commits what a button did on the head, as a manual run’s is', async () => {
    const { api, calls } = fakeApi();
    const runtime = createScriptRuntime({ chatId: 'c1', api, ui: silentUi, bundle: bundle({ triggers: lua }), engines: [writer()] });
    const head = message('m2', 'm1', 'assistant', '답', { scriptRev: 4 });
    await runtime.button('go', view([greeting, branch[1]!, head]));
    expect(calls).toEqual([
      {
        method: 'POST',
        path: '/api/chats/c1/script-commit',
        body: {
          messageId: 'm2',
          scriptRev: 4,
          variableDelta: { pressed: 'go' },
          content: '버튼이 고친 답',
          overlay: { members: { '00000000-0000-4000-8000-000000000001': { description: '버튼이 바꾼 설명' } } },
        },
      },
    ]);
  });

  it('draws messages through the display listeners, by message, with the chat’s index for each', async () => {
    const runtime = createScriptRuntime({ chatId: 'c1', api: fakeApi().api, ui: silentUi, bundle: bundle({ triggers: lua }), engines: [writer()] });
    expect(runtime.editsDisplay).toBe(true);
    const shown = await runtime.displayEdits(
      [
        { id: 'm0', text: '어서 와.' },
        { id: 'm1', text: '들어간다' },
      ],
      view(branch),
      vars({ hp: '7' }),
    );
    expect([...shown]).toEqual([
      ['m0', '어서 와.|7|-1'],
      ['m1', '들어간다|7|0'],
    ]);
  });
});

describe('the chat a run leaves', () => {
  const impersonate = (role: 'user' | 'char', value: string): TriggerStep => ({
    type: 'v2Impersonate',
    role,
    value,
    valueType: 'value',
    indent: 0,
  });
  const cut = (start: string, end: string): TriggerStep => ({
    type: 'v2CutChat',
    start,
    startType: 'value',
    end,
    endType: 'value',
    indent: 0,
  });
  const exchange = [greeting, message('m1', 'm0', 'user', '{{setvar::hp::50}}앉는다'), message('m2', 'm1', 'assistant', '응.', { variableDelta: { mood: 'calm' } })];

  it('sends the turn where the runs left it — after the input run’s cut, before what the start run added — with the delta on the last', async () => {
    const { api, calls } = fakeApi();
    const runtime = createScriptRuntime({
      chatId: 'c1',
      api,
      ui: silentUi,
      bundle: bundle({
        triggers: [
          trigger('input', [cut('1', '2')]),
          trigger('start', [impersonate('char', '[독백]'), setvar('hp', '5', '-=')]),
        ],
      }),
    });
    const prepared = await runtime.prepare('send', view(exchange), '{{addvar::hp::1}}들어간다');
    expect(calls).toEqual([]);
    expect(prepared.content).toBe('{{addvar::hp::1}}들어간다');
    expect(prepared.body['chat']).toEqual({ keep: 0, messages: [{ id: 'm2' }, { turn: true }, { role: 'assistant', content: '[독백]' }] });
    // Folded where the server keeps it — the cut message gone, the turn, then the
    // added message carrying the delta — it is where the runs ended.
    const kept = [greeting, exchange[2]!, { content: prepared.content! }, { content: '[독백]', variableDelta: prepared.body['variableDelta'] as Record<string, string> }];
    expect(serverFold(kept)).toEqual(vars({ hp: '46', mood: 'calm' }));

    // A start run that cuts the turn: the chat says so, and the delta lands on
    // what the chat ends on — without the macros of the turn that is not stored.
    const cutting = createScriptRuntime({
      chatId: 'c1',
      api,
      ui: silentUi,
      bundle: bundle({ triggers: [trigger('start', [cut('0', '2'), setvar('door', 'open')])] }),
    });
    const sent = await cutting.prepare('send', view(exchange), '{{setvar::typed::1}}또');
    expect(sent.body['chat']).toEqual({ keep: 2, messages: [] });
    const ends = [greeting, exchange[1]!, { ...exchange[2]!, variableDelta: sent.body['variableDelta'] as Record<string, string | null> }];
    expect(serverFold(ends)).toEqual(vars({ hp: '50', mood: 'calm', door: 'open' }));
  });

  it('sends the other generations’ chat, and a start delta measured against the branch it leaves', async () => {
    const runtime = createScriptRuntime({
      chatId: 'c1',
      api: fakeApi().api,
      ui: silentUi,
      bundle: bundle({ triggers: [trigger('start', [cut('1', '2'), impersonate('user', '{{setvar::hp::7}}끼어듦'), setvar('seen', '1')])] }),
    });
    const auto = await runtime.prepare('auto', view(exchange));
    expect(auto.body['chat']).toEqual({ keep: 0, messages: [{ id: 'm2' }, { role: 'user', content: '{{setvar::hp::7}}끼어듦' }] });
    // The run read hp=50 from the message it cut; the branch it leaves folds to 7, and the start delta puts 50 back.
    const left = serverFold([greeting, exchange[2]!, { content: '{{setvar::hp::7}}끼어듦' }]);
    expect(applyVariableDelta(left, auto.body['startDelta'] as Record<string, string>)).toEqual(vars({ hp: '50', mood: 'calm', seen: '1' }));

    // A regenerate's run reads the branch without the reply it replaces, and its chat is said against that.
    const regenerate = await runtime.prepare('regenerate', view(exchange));
    expect(regenerate.body['chat']).toEqual({ keep: 0, messages: [{ role: 'user', content: '{{setvar::hp::7}}끼어듦' }] });
  });

  it('commits what the output triggers added after the reply, with the delta on what they added', async () => {
    const { api, calls } = fakeApi();
    const runtime = createScriptRuntime({
      chatId: 'c1',
      api,
      ui: silentUi,
      bundle: bundle({
        triggers: [trigger('output', [impersonate('user', '다음 행동'), setvar('hp', '10', '-=')])],
        editScripts: [{ type: 'editoutput', in: '다친 것 같다', out: '다쳤다' }],
      }),
    });
    await runtime.finish(view(branch));
    const body = calls[0]!.body;
    expect(body).toMatchObject({
      messageId: 'm2',
      clearPending: true,
      // The reply as its edit scripts left it, in place; the chat is said against it.
      content: '{{setvar::hp::90}}다쳤다.',
      chat: { keep: 2, messages: [{ role: 'user', content: '다음 행동' }] },
    });
    const stored = [
      ...branch.slice(0, -1),
      { content: body['content'] as string, variableDelta: reply.variableDelta },
      { content: '다음 행동', variableDelta: body['variableDelta'] as Record<string, string> },
    ];
    expect(serverFold(stored)).toEqual(vars({ hp: '80', mood: 'tense' }));
  });

  it('commits a manual run’s cut and a button’s role change as the chat, and a rewrite of the head alone as its text', async () => {
    const { api, calls } = fakeApi();
    const runtime = createScriptRuntime({
      chatId: 'c1',
      api,
      ui: silentUi,
      bundle: bundle({
        triggers: [
          trigger('manual', [cut('1', '2')], { comment: '잘라' }),
          trigger('manual', [{ type: 'v2ModifyChat', index: '1', indexType: 'value', value: '고친 답', valueType: 'value', indent: 0 }], {
            comment: '고쳐',
          }),
        ],
      }),
      engines: [
        {
          name: 'lua',
          handles: () => true,
          button: async (_data, scope) => {
            scope.messages[0]!.role = 'char';
          },
        },
      ],
    });
    await runtime.manual('잘라', null, view(exchange));
    expect(calls[0]!.body).toMatchObject({ messageId: 'm2', chat: { keep: 0, messages: [{ id: 'm2' }] } });
    // Nothing of the cut message's macro is in the fold the delta is measured over.
    expect(serverFold([greeting, { ...exchange[2]!, variableDelta: calls[0]!.body['variableDelta'] as Record<string, string | null> }])).toEqual(
      vars({ hp: '50', mood: 'calm' }),
    );
    await runtime.manual('고쳐', null, view(exchange));
    expect(calls[1]!.body).toMatchObject({ messageId: 'm2', content: '고친 답' });
    expect(calls[1]!.body['chat']).toBeUndefined();
    await runtime.button('go', view(exchange));
    expect(calls[2]!.body).toMatchObject({ chat: { keep: 0, messages: [{ id: 'm1', role: 'assistant' }, { id: 'm2' }] } });
  });

  it('keeps a stopped send’s turn, with what the start run did around it, for the page to store', async () => {
    const { api, calls } = fakeApi(() => ({ marker: 'kept' }) as unknown as ChatState);
    const runtime = createScriptRuntime({
      chatId: 'c1',
      api,
      ui: silentUi,
      bundle: bundle({
        triggers: [
          trigger('output', []),
          trigger('start', [impersonate('char', '굴림: 7'), setvar('roll', '7'), { type: 'stop' }]),
        ],
      }),
    });
    const stopped = await runtime.prepare('send', view(exchange), '{{setvar::typed::1}}/굴림');
    // RisuAI pushes the turn before the start triggers run: it is stored as a
    // send stores it, with no reply asked for and nothing committed here.
    expect(calls).toEqual([]);
    expect(stopped).toMatchObject({ stop: true, content: '{{setvar::typed::1}}/굴림' });
    expect(stopped.state).toBeUndefined();
    expect(stopped.body).toMatchObject({
      baseHeadId: 'm2',
      chat: { keep: 2, messages: [{ turn: true }, { role: 'assistant', content: '굴림: 7' }] },
    });
    expect(stopped.body['postProcess']).toBeUndefined();
    expect(stopped.body['injections']).toBeUndefined();
    // The values the run wrote and the turn's own macros, as the stored chat folds them.
    const kept = [...exchange, { content: stopped.content! }, { content: '굴림: 7', variableDelta: stopped.body['variableDelta'] as Record<string, string> }];
    expect(serverFold(kept)).toEqual(vars({ hp: '50', mood: 'calm', roll: '7', typed: '1' }));
  });

  it('commits a stopped regenerate without the reply it was to replace, as RisuAI’s reroll leaves the chat', async () => {
    const { api, calls } = fakeApi(() => ({ marker: 'kept' }) as unknown as ChatState);
    const runtime = createScriptRuntime({
      chatId: 'c1',
      api,
      ui: silentUi,
      bundle: bundle({ triggers: [trigger('start', [{ type: 'stop' }])] }),
    });
    // Nothing else changed: the reply still goes, and the chat ends on the turn.
    const plain = await runtime.prepare('regenerate', view(exchange));
    expect(plain).toMatchObject({ stop: true, state: { marker: 'kept' } });
    expect(calls[0]!.body).toMatchObject({ messageId: 'm2', variableDelta: null, chat: { keep: 1, messages: [] } });

    const writing = createScriptRuntime({
      chatId: 'c1',
      api,
      ui: silentUi,
      bundle: bundle({ triggers: [trigger('start', [impersonate('char', '굴림: 7'), setvar('roll', '7'), { type: 'stop' }])] }),
    });
    await writing.prepare('regenerate', view(exchange));
    expect(calls[1]!.body).toMatchObject({ messageId: 'm2', chat: { keep: 1, messages: [{ role: 'assistant', content: '굴림: 7' }] } });
    // Folded on the branch it leaves — the reply gone — it is where the run ended.
    const left = [...exchange.slice(0, 2), { content: '굴림: 7', variableDelta: calls[1]!.body['variableDelta'] as Record<string, string> }];
    expect(serverFold(left)).toEqual(vars({ hp: '50', roll: '7' }));
  });

  it('keeps what a stopped run wrote when it left the chat as it was, and commits nothing when it wrote nothing', async () => {
    const { api, calls } = fakeApi(() => ({ marker: 'kept' }) as unknown as ChatState);
    const writing = createScriptRuntime({
      chatId: 'c1',
      api,
      ui: silentUi,
      bundle: bundle({
        triggers: [
          trigger('start', [setvar('roll', '7'), { type: 'v2SetAuthorNote', value: '비', valueType: 'value', indent: 0 }, { type: 'stop' }]),
        ],
      }),
    });
    const auto = await writing.prepare('auto', view(exchange));
    expect(auto).toMatchObject({ stop: true, state: { marker: 'kept' } });
    expect(calls[0]!.body).toMatchObject({ messageId: 'm2', note: '비' });
    expect(calls[0]!.body['chat']).toBeUndefined();
    const head = { ...exchange[2]!, variableDelta: calls[0]!.body['variableDelta'] as Record<string, string> };
    expect(serverFold([...exchange.slice(0, 2), head])).toEqual(vars({ hp: '50', mood: 'calm', roll: '7' }));

    const idle = createScriptRuntime({
      chatId: 'c1',
      api,
      ui: silentUi,
      bundle: bundle({ triggers: [trigger('start', [{ type: 'stop' }])] }),
    });
    expect(await idle.prepare('continue', view(exchange))).toMatchObject({ stop: true });
    expect(calls).toHaveLength(1);
  });

  it('says and drops an edit of the chat past what the server takes', async () => {
    const logged: string[] = [];
    const runtime = createScriptRuntime({
      chatId: 'c1',
      api: fakeApi().api,
      ui: silentUi,
      bundle: bundle({ triggers: [trigger('start', [{ type: 'triggerlua', code: 'x' }])] }),
      log: (entry) => logged.push(entry.message),
      engines: [
        {
          name: 'lua',
          handles: () => true,
          runCode: async (request) => {
            for (let i = 0; i <= MAX_SCRIPT_CHAT_MESSAGES; i += 1) request.scope.messages.push({ role: 'user', data: String(i) });
          },
        },
      ],
    });
    const prepared = await runtime.prepare('auto', view(exchange));
    expect(prepared.body['chat']).toBeUndefined();
    expect(logged.some((line) => line.includes('could not be kept'))).toBe(true);
  });
});

describe('slash commands', () => {
  const exchange = [greeting, message('m1', 'm0', 'user', '앉는다'), message('m2', 'm1', 'assistant', '응.', { variableDelta: { mood: 'calm' } })];
  const command = (value: string): TriggerStep => ({ type: 'command', value });

  /** A ui that answers from a script and notes what it was asked. */
  function recordingUi(answers: { input?: string; select?: string } = {}) {
    const asked: string[] = [];
    const ui: ScriptUi = {
      alert: async (text) => void asked.push(`alert:${text}`),
      input: async (text) => {
        asked.push(`input:${text}`);
        return answers.input ?? '';
      },
      select: async (options) => {
        asked.push(`select:${options.join(',')}`);
        return answers.select ?? '';
      },
      confirm: async () => false,
      help: async () => void asked.push('help'),
    };
    return { ui, asked };
  }

  it('in a send: keep an input run’s variables when it wrote none itself, and lose what the start run’s copy replaces', async () => {
    const { api } = fakeApi();
    const runtime = createScriptRuntime({
      chatId: 'c1',
      api,
      ui: silentUi,
      bundle: bundle({
        triggers: [
          trigger('input', [command('/setvar key=mood happy|/send 사라짐')]),
          trigger('start', [command('/setvar key=hp 1|/sendas 사라짐')]),
        ],
      }),
    });
    const prepared = await runtime.prepare('send', view(exchange), '또');
    expect(prepared.body['chat']).toBeUndefined();
    const stored = [...exchange, { content: '또', variableDelta: prepared.body['variableDelta'] as Record<string, string> }];
    expect(serverFold(stored)).toEqual(vars({ hp: '100', mood: 'happy' }));

    // An input run that changes a variable itself hands its own back, without the command's.
    const writing = createScriptRuntime({
      chatId: 'c1',
      api,
      ui: silentUi,
      bundle: bundle({ triggers: [trigger('input', [command('/setvar key=mood happy'), setvar('seen', '1')])] }),
    });
    const lost = await writing.prepare('send', view(exchange), '또');
    expect(serverFold([...exchange, { content: '또', variableDelta: lost.body['variableDelta'] as Record<string, string> }])).toEqual(
      vars({ hp: '100', mood: 'calm', seen: '1' }),
    );
  });

  it('in an output, a manual or a stopped-early run: lose the chat and variables to the run’s copy, unless the run ended early', async () => {
    const { api, calls } = fakeApi();
    const runtime = createScriptRuntime({
      chatId: 'c1',
      api,
      ui: silentUi,
      bundle: bundle({
        triggers: [
          trigger('output', [command('/send 사라짐|/setvar key=gone 1')]),
          trigger('manual', [command('/sendas 사라짐|/setvar key=gone 1')], { comment: '버튼' }),
          trigger('start', [command('/send 남는다|/setvar key=kept 1'), command('/getvar key=none')]),
        ],
      }),
    });
    await runtime.finish(view(branch));
    expect(calls[0]!.body['chat']).toBeUndefined();
    expect(calls[0]!.body['variableDelta']).not.toHaveProperty('gone');
    expect(await runtime.manual('버튼', null, view(exchange))).toBeNull();
    // `/getvar` of an unset variable throws, and RisuAI writes nothing back over the stored chat.
    const auto = await runtime.prepare('auto', view(exchange));
    expect(auto.body['chat']).toEqual({ keep: 2, messages: [{ role: 'user', content: '남는다' }] });
    expect(applyVariableDelta(serverFold([...exchange, { content: '남는다' }]), auto.body['startDelta'] as Record<string, string>)).toEqual(
      vars({ hp: '100', mood: 'calm', kept: '1' }),
    );
  });

  it('from the composer: commits what the line did on the head, and says whether to send the text', async () => {
    const { api, calls } = fakeApi(() => ({ marker: 'committed' }) as unknown as ChatState);
    const runtime = createScriptRuntime({ chatId: 'c1', api, ui: silentUi, bundle: bundle() });
    const outcome = await runtime.command('/send 문을 연다|/sendas 들어와.|/setvar key=door open', view(exchange));
    expect(outcome).toEqual({ send: false, state: { marker: 'committed' }, turns: [] });
    expect(calls[0]).toMatchObject({
      path: '/api/chats/c1/script-commit',
      body: { messageId: 'm2', scriptRev: 0, chat: { keep: 2, messages: [{ role: 'user', content: '문을 연다' }, { role: 'assistant', content: '들어와.' }] } },
    });
    const stored = [...exchange, { content: '문을 연다' }, { content: '들어와.', variableDelta: calls[0]!.body['variableDelta'] as Record<string, string> }];
    expect(serverFold(stored)).toEqual(vars({ hp: '100', mood: 'calm', door: 'open' }));

    // A command RisuAI does not run answers false: the text is sent, and nothing was committed.
    expect(await runtime.command('/모름 이건 그냥 글', view(exchange))).toEqual({ send: true, turns: [] });
    expect(calls).toHaveLength(1);
    // One that throws keeps what came before it, and the text is not sent.
    const thrown = await runtime.command('/comment 메모|/getvar key=none', view(exchange));
    expect(thrown).toMatchObject({ send: false, error: expect.stringContaining('none') });
    expect(calls[1]!.body).toMatchObject({ messageId: 'm2', content: '응.<Comment>\n메모\n</Comment>' });
  });

  it('from the composer: asks through the page’s dialogs and shows the list of commands', async () => {
    const { ui, asked } = recordingUi({ input: '아린', select: '1' });
    const { api, calls } = fakeApi();
    const runtime = createScriptRuntime({ chatId: 'c1', api, ui, bundle: bundle() });
    await runtime.command('/input 이름은?|/echo {{pipe}} 님|/buttons labels=["가","나"]|/setvar key=pick', view(exchange));
    expect(asked).toEqual(['input:이름은?', 'alert:아린 님', 'select:가,나']);
    expect(applyVariableDelta(serverFold(exchange), calls[0]!.body['variableDelta'] as Record<string, string>)).toMatchObject({ pick: '1' });
    expect(await runtime.command('/?', view(exchange))).toEqual({ send: false, turns: [] });
    expect(asked.at(-1)).toBe('help');
  });

  it('from the composer: tests the lore on the chat, and runs a manual trigger with /trigger', async () => {
    const { ui, asked } = recordingUi();
    const { api, calls } = fakeApi();
    const lore = {
      name: '성',
      keys: ['앉'],
      secondaryKeys: [],
      selective: false,
      content: '북쪽의 성',
      enabled: true,
      constant: false,
      insertionOrder: 100,
      caseSensitive: false,
      useRegex: false,
      position: 'before_char' as const,
    };
    const runtime = createScriptRuntime({
      chatId: 'c1',
      api,
      ui,
      bundle: bundle({
        triggers: [trigger('manual', [setvar('hit', '1')], { comment: '공격' })],
        character: { ...bundle().character, lorebook: [lore], loreSettings: { scanDepth: 4, recursiveScanning: false, risuMatching: true } },
      }),
    });
    await runtime.command('/test_lorebook|/setvar key=lore', view(exchange));
    expect(asked).toEqual(['alert:북쪽의 성']);
    const written = applyVariableDelta(serverFold(exchange), calls[0]!.body['variableDelta'] as Record<string, string>);
    expect(JSON.parse(written['lore']!)).toEqual({
      actives: [{ depth: 0, pos: '', prompt: '북쪽의 성', role: 'system', order: 100, tokens: 2, priority: 100, source: '성', inject: null }],
      matchLog: [],
    });
    await runtime.command('/trigger 공격', view(exchange));
    expect(applyVariableDelta(serverFold(exchange), calls[1]!.body['variableDelta'] as Record<string, string>)).toMatchObject({ hit: '1' });
  });

  it('from the composer: answers only the first /multisend message, and appends the rest as RisuAI leaves them', async () => {
    const list = view(exchange, { defaults: vars({ hp: '100', list: 'clear|||가|||나' }) });
    const plain = createScriptRuntime({ chatId: 'c1', api: fakeApi().api, ui: silentUi, bundle: bundle() });
    expect((await plain.command('/multisend {{getvar::list}}|/multisend 다', list)).turns).toEqual([
      { kind: 'send', content: '가', clear: true },
      { kind: 'append', items: [{ content: '나', clear: true }, { content: '다', clear: false }] },
    ]);
    // On a card with triggers the rest of that /multisend lands on a chat the start run replaced.
    const scripted = createScriptRuntime({
      chatId: 'c1',
      api: fakeApi().api,
      ui: silentUi,
      bundle: bundle({ triggers: [trigger('display', [])] }),
    });
    expect((await scripted.command('/multisend {{getvar::list}}|/multisend 다', list)).turns).toEqual([
      { kind: 'send', content: '가', clear: true },
      { kind: 'append', items: [{ content: '다', clear: false }] },
    ]);
  });

  it('sends a /multisend message as it is, after the chat is emptied, and appends the rest on the head', async () => {
    const { api, calls } = fakeApi();
    const runtime = createScriptRuntime({
      chatId: 'c1',
      api,
      ui: silentUi,
      bundle: bundle({
        triggers: [trigger('input', [setvar('typed', '1')])],
        editScripts: [{ type: 'editinput', in: '가', out: '바뀜' }],
      }),
    });
    const prepared = await runtime.prepare('send', view(exchange), '가', { raw: true, clear: true });
    expect(prepared.content).toBe('가');
    expect(prepared.body['chat']).toEqual({ keep: 0, messages: [{ turn: true }] });
    // Chat variables outlive the cut: the turn's delta keeps the branch's.
    expect(serverFold([greeting, { content: '가', variableDelta: prepared.body['variableDelta'] as Record<string, string> }])).toEqual(
      vars({ hp: '100', mood: 'calm' }),
    );
    await runtime.append([{ content: '나', clear: false }], view(exchange));
    expect(calls[0]!.body).toMatchObject({ messageId: 'm2', chat: { keep: 2, messages: [{ role: 'user', content: '나' }] } });
    await runtime.append([{ content: '나', clear: false }, { content: '다', clear: true }], view(exchange));
    expect(calls[1]!.body).toMatchObject({ messageId: 'm2', chat: { keep: 0, messages: [{ role: 'user', content: '다' }] } });
  });
});

describe('the name, the first message and the background', () => {
  const memberId = '00000000-0000-4000-8000-000000000001';
  const lua = [trigger('manual', [{ type: 'triggerlua', code: 'x' }], { comment: '이름' })];

  it('go to the overlay, reach the page, and are what the next run reads', async () => {
    const { api, calls } = fakeApi();
    const seen: unknown[] = [];
    const overlays: unknown[] = [];
    let first = true;
    const runtime = createScriptRuntime({
      chatId: 'c1',
      api,
      ui: silentUi,
      bundle: bundle({
        triggers: lua,
        character: { ...bundle().character, name: '리안', nickname: '', backgroundHtml: '<style>.a{}</style>' },
      }),
      onOverlay: (member) => void overlays.push(member),
      engines: [
        {
          name: 'lua',
          handles: () => true,
          runCode: async ({ scope }) => {
            const { name, memberName, firstMessage, backgroundHtml } = scope.character;
            seen.push({ name, memberName, firstMessage, backgroundHtml, greeting: scope.greeting });
            if (!first) return;
            first = false;
            scope.setName('세라');
            scope.setFirstMessage('새 인사');
            scope.setBackgroundHtml('<div>밤</div>');
          },
        },
      ],
    });
    await runtime.manual('이름', null, view([greeting], { firstGreeting: true }));
    expect(calls[0]!.body['overlay']).toEqual({
      members: { [memberId]: { name: '세라', firstMessage: '새 인사', backgroundHtml: '<div>밤</div>' } },
    });
    expect(overlays).toEqual([{ name: '세라', firstMessage: '새 인사', backgroundHtml: '<div>밤</div>' }]);

    // On the first opening the greeting is the first message the scripts set; on another, the stored one.
    await runtime.manual('이름', null, view([greeting], { firstGreeting: true }));
    await runtime.manual('이름', null, view([greeting], { firstGreeting: false }));
    expect(seen).toEqual([
      { name: '리안', memberName: '리안', firstMessage: undefined, backgroundHtml: '<style>.a{}</style>', greeting: '어서 와.' },
      { name: '세라', memberName: '세라', firstMessage: '새 인사', backgroundHtml: '<div>밤</div>', greeting: '새 인사' },
      { name: '세라', memberName: '세라', firstMessage: '새 인사', backgroundHtml: '<div>밤</div>', greeting: '어서 와.' },
    ]);
  });

  it('keep `{{char}}` the nickname through a rename, and let the triggers read the first message the overlay holds', async () => {
    const { api } = fakeApi();
    const runtime = createScriptRuntime({
      chatId: 'c1',
      api,
      ui: silentUi,
      bundle: bundle({
        name: '리리',
        triggers: [trigger('start', [{ type: 'v2GetFirstMessage', outputVar: 'fm', indent: 0 }, setvar('who', '{{char}}')])],
        character: { ...bundle().character, name: '리안', nickname: '리리' },
        overlay: { member: { name: '세라', firstMessage: '새 인사' }, persona: null },
      }),
    });
    const onFirst = await runtime.prepare('auto', view([greeting], { firstGreeting: true }));
    expect(onFirst.body['startDelta']).toEqual({ fm: '새 인사', who: '리리' });
    const onAnother = await runtime.prepare('auto', view([greeting], { firstGreeting: false }));
    expect(onAnother.body['startDelta']).toEqual({ fm: '어서 와.', who: '리리' });
  });
});

describe('loadWholeBranch', () => {
  it('reads every window before the loaded one, oldest last', async () => {
    const all = Array.from({ length: 5 }, (_, index) =>
      message(`m${index}`, index === 0 ? null : `m${index - 1}`, index % 2 ? 'user' : 'assistant', String(index)),
    );
    const windowOf = (end: number, size: number): ChatState =>
      ({ path: all.slice(Math.max(0, end - size), end), siblings: {}, hasMore: end - size > 0 }) as unknown as ChatState;
    const reads: string[] = [];
    const whole = await loadWholeBranch(windowOf(5, 2), async (cursor) => {
      reads.push(cursor);
      return windowOf(all.findIndex((entry) => entry.id === cursor), 2);
    });
    expect(whole.path.map((entry) => entry.id)).toEqual(['m0', 'm1', 'm2', 'm3', 'm4']);
    expect(whole.hasMore).toBe(false);
    expect(reads).toEqual(['m3', 'm1']);
  });
});

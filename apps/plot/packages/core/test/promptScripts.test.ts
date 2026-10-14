import { describe, expect, it } from 'vitest';
import {
  expandPromptScript,
  MAX_SCRIPT_GROWTH,
  promptScriptJob,
  promptScriptsOf,
  promptScriptsOfCard,
  runPromptScripts,
  type PromptScript,
  type PromptScriptMessage,
} from '../src/promptScripts.js';

/** A RisuAI `editprocess` entry as a card stores it. */
const risu = (fields: Record<string, unknown>): Record<string, unknown> => ({
  comment: '',
  type: 'editprocess',
  ableFlag: false,
  flag: '',
  ...fields,
});

/** A SillyTavern regex script as a card stores it, prompt-only on both kinds of turn. */
const tavern = (fields: Record<string, unknown>): Record<string, unknown> => ({
  scriptName: 's',
  replaceString: '',
  trimStrings: [],
  placement: [1, 2],
  disabled: false,
  markdownOnly: false,
  promptOnly: true,
  runOnEdit: true,
  substituteRegex: 0,
  minDepth: null,
  maxDepth: null,
  ...fields,
});

const scriptsOf = (customScripts: unknown[] = [], regexScripts: unknown[] = []): PromptScript[] =>
  promptScriptsOfCard({ risuai: { customScripts }, regex_scripts: regexScripts });

/** Runs `scripts` over turns given as `[role, text]`, the first the greeting. */
const run = (
  scripts: PromptScript[],
  turns: [PromptScriptMessage['role'], string][],
  greeting = true,
): string[] =>
  runPromptScripts(
    promptScriptJob(
      turns.map(([role, content]) => ({ role, content })),
      scripts,
      greeting ? { length: turns.length, greeting: { text: turns[0]![1] } } : { length: turns.length },
    ),
  );

describe('promptScriptsOfCard', () => {
  it("reads RisuAI's editprocess scripts in the order it runs them, and nothing else of the list", () => {
    const scripts = scriptsOf([
      risu({ in: 'a', out: 'A' }),
      risu({ type: 'editdisplay', in: 'd', out: 'D' }),
      risu({ in: 'b', out: 'B', ableFlag: true, flag: 'g<order 5>' }),
      risu({ in: '', out: 'empty' }),
      risu({ in: 'c', out: 'C', ableFlag: true, flag: '<move_top, cbs>i' }),
    ]);
    // One `<order>` sorts the list, highest first, the rest counting as 0.
    expect(scripts).toEqual([
      { kind: 'risuai', in: 'b', out: 'B', flag: 'g', actions: [] },
      { kind: 'risuai', in: 'a', out: 'A', flag: '', actions: [] },
      { kind: 'risuai', in: 'c', out: 'C', flag: 'i', actions: ['move_top', 'cbs'] },
    ]);
  });

  it('ignores the flag field, directives and all, with ableFlag off', () => {
    expect(scriptsOf([risu({ in: 'a', flag: 'i<move_top><order 3>' })])).toEqual([
      { kind: 'risuai', in: 'a', out: '', flag: '', actions: [] },
    ]);
  });

  it("reads SillyTavern's prompt-only scripts on the turns' placements, and no others", () => {
    const scripts = scriptsOf(
      [],
      [
        tavern({ findRegex: '/x/g', replaceString: 'y', minDepth: 1, maxDepth: '3', substituteRegex: 2 }),
        tavern({ findRegex: 'display', promptOnly: false, markdownOnly: true }),
        tavern({ findRegex: 'stored', promptOnly: false }),
        tavern({ findRegex: 'off', disabled: true }),
        tavern({ findRegex: 'slash', placement: [3] }),
        tavern({ findRegex: '' }),
        tavern({ findRegex: 'both', markdownOnly: true, placement: [2, 3], trimStrings: ['', 't'] }),
      ],
    );
    expect(scripts).toEqual([
      {
        kind: 'sillytavern',
        find: '/x/g',
        replace: 'y',
        trimStrings: [],
        placement: [1, 2],
        minDepth: 1,
        maxDepth: 3,
        substitute: 2,
      },
      { kind: 'sillytavern', find: 'both', replace: '', trimStrings: ['t'], placement: [2], substitute: 0 },
    ]);
  });
});

describe('expandPromptScript', () => {
  const expand = (text: string): string => text.replaceAll('{{char}}', 'A.ria').replaceAll('{{user}}', '민준');

  it("expands a <cbs> script's pattern, and only that one's", () => {
    const [cbs, plain] = scriptsOf([
      risu({ in: '{{char}}', ableFlag: true, flag: '<cbs>' }),
      risu({ in: '{{char}}' }),
    ]);
    expect(expandPromptScript(cbs!, expand)).toMatchObject({ in: 'A.ria' });
    expect(expandPromptScript(plain!, expand)).toMatchObject({ in: '{{char}}' });
  });

  it("expands an ST pattern as its substituteRegex says, and every trim string", () => {
    const [none, raw, escaped] = scriptsOf(
      [],
      [
        tavern({ findRegex: '/{{char}}/', trimStrings: ['{{user}}'] }),
        tavern({ findRegex: '/{{char}}/', substituteRegex: 1 }),
        tavern({ findRegex: '/{{char}}/', substituteRegex: 2 }),
      ],
    );
    expect(expandPromptScript(none!, expand)).toMatchObject({ find: '/{{char}}/', trimStrings: ['민준'] });
    expect(expandPromptScript(raw!, expand)).toMatchObject({ find: '/A.ria/' });
    expect(expandPromptScript(escaped!, expand)).toMatchObject({ find: '/A\\.ria/' });
  });
});

describe('promptScriptsOf', () => {
  it('runs a script two members carry once, each expanded for its own card', () => {
    const shared = risu({ in: 'x', out: 'y' });
    const scripts = promptScriptsOf(
      [
        { extensions: { risuai: { customScripts: [shared, risu({ in: '{{char}}', ableFlag: true, flag: '<cbs>' })] } } },
        { extensions: { risuai: { customScripts: [shared, risu({ in: '{{char}}', ableFlag: true, flag: '<cbs>' })] } } },
      ],
      (text, card) => text.replace('{{char}}', card === 0 ? '하나' : '둘'),
    );
    expect(scripts.map((script) => (script.kind === 'risuai' ? script.in : ''))).toEqual(['x', '하나', '둘']);
  });
});

describe('promptScriptJob', () => {
  it("numbers the turns as RisuAI does and measures their depth as ST does", () => {
    const turns = [
      { role: 'user' as const, content: 'c' },
      { role: 'assistant' as const, content: 'd' },
    ];
    // The memory trimmed the greeting and two messages off the front.
    expect(promptScriptJob(turns, [], { length: 5, greeting: { text: 'g' } })).toEqual({
      scripts: [],
      messages: [
        { text: 'c', role: 'user', chatIndex: 2, depth: 1 },
        { text: 'd', role: 'assistant', chatIndex: 3, depth: 0 },
      ],
      greeting: 'g',
    });
    expect(promptScriptJob(turns, []).messages.map((message) => message.chatIndex)).toEqual([0, 1]);
  });

  it('counts no turn hidden from the AI toward depth, as ST counts its coreChat', () => {
    const turns = [
      { role: 'user' as const, content: 'a' },
      { role: 'assistant' as const, content: 'b', hidden: true },
      { role: 'user' as const, content: 'c' },
      { role: 'assistant' as const, content: 'd', hidden: true },
    ];
    const job = promptScriptJob(turns, []);
    expect(job.messages.map((message) => message.chatIndex)).toEqual([0, 1, 2, 3]);
    expect([job.messages[0]!.depth, job.messages[2]!.depth]).toEqual([1, 0]);
  });
});

describe('runPromptScripts - RisuAI', () => {
  it('rewrites every turn, the greeting included, script after script', () => {
    const scripts = scriptsOf([
      risu({ in: '<status>([\\s\\S]*?)</status>', out: '[$1]$n' }),
      risu({ in: '\\[(\\d+)\\]', out: '<b>$&</b>' }),
    ]);
    expect(
      run(scripts, [
        ['assistant', 'hi <status>1</status>'],
        ['user', 'no status'],
        ['assistant', '<status>2</status> and <status>3</status>'],
      ]),
    ).toEqual([
      // `$n` is a line break, and a template ending in `>` gets one too.
      'hi <b>[1]</b>\n\n',
      'no status',
      '<b>[2]</b>\n\n and <b>[3]</b>\n\n',
    ]);
  });

  it('rewrites the first match only when the compiled flags have no g', () => {
    const scripts = scriptsOf([risu({ in: 'a', out: 'b', ableFlag: true, flag: 'i' })]);
    expect(run(scripts, [['assistant', 'AaA']], false)).toEqual(['baA']);
  });

  it('moves a match to the top or the bottom of the turn', () => {
    const scripts = scriptsOf([
      risu({ in: '<s>(.*?)</s>', out: '@@move_top [$1]' }),
      risu({ in: '#(\\w+)', out: '($1)', ableFlag: true, flag: '<move_bottom>' }),
    ]);
    // A move takes the g away: only the first match goes.
    expect(run(scripts, [['assistant', 'a<s>x</s>b<s>y</s> #tag #more']], false)).toEqual([
      '[x]\nab<s>y</s>  #more\n(tag)',
    ]);
  });

  it('takes an inject match out of every turn but the greeting, which it rewrites instead', () => {
    const scripts = scriptsOf([risu({ in: '<hidden>', out: 'gone', ableFlag: true, flag: 'g<inject>' })]);
    expect(
      run(scripts, [
        ['assistant', 'greet<hidden>'],
        ['user', 'u<hidden>'],
      ]),
    ).toEqual(['greetgone', 'u']);
  });

  it("repeats the latest same-role turn's match where a turn has none, the greeting's for the first", () => {
    const scripts = scriptsOf([risu({ in: '\\[HP \\d+\\]', out: '$&', ableFlag: true, flag: '<repeat_back>' })]);
    expect(
      run(scripts, [
        ['assistant', 'g [HP 9]'],
        ['user', 'u1'],
        ['assistant', 'a1 [HP 5]'],
        ['user', 'u2'],
        ['assistant', 'a2'],
      ]),
      // The earlier turn is read as stored: `u1` has no match of its own, so `u2`
      // finds none — RisuAI throws there, and the turn stays as it was.
    ).toEqual(['g [HP 9]', 'u1[HP 9]', 'a1 [HP 5]', 'u2', 'a2[HP 5]']);
  });

  it('leaves a turn as it was where a script throws, and skips a pattern that does not compile', () => {
    const scripts = scriptsOf([
      risu({ in: '(', out: 'x' }),
      // No earlier match to repeat: RisuAI throws, and the turn stays.
      risu({ in: 'nowhere', out: '@@repeat_back' }),
      risu({ in: 'b', out: 'c' }),
      // An expression changes on a screen, and nothing here.
      risu({ in: 'c', out: '@@emo happy' }),
    ]);
    expect(run(scripts, [['user', 'abc']], false)).toEqual(['acc']);
  });

  it('drops a step that grows a turn past the cap', () => {
    const scripts = scriptsOf([
      risu({ in: '.', out: '$&'.repeat(50) }),
      risu({ in: '^', out: 'ok ' }),
    ]);
    const long = 'x'.repeat(Math.ceil(MAX_SCRIPT_GROWTH / 40));
    expect(run(scripts, [['user', long]], false)).toEqual([`ok ${long}`]);
  });

  it('marks the script it is on, for a caller that has to know where a run stopped', () => {
    const seen: number[] = [];
    const scripts = scriptsOf([risu({ in: 'a', out: 'b' }), risu({ in: 'b', out: 'c' })]);
    runPromptScripts(promptScriptJob([{ role: 'user', content: 'a' }], scripts), (index) => seen.push(index));
    expect(seen).toEqual([0, 1]);
  });
});

describe('runPromptScripts - SillyTavern', () => {
  it('builds the replacement as ST does: the match and the groups with the trims out, and no $&', () => {
    const scripts = scriptsOf(
      [],
      [
        tavern({
          findRegex: '/<(\\w+)>(?<body>[^<]*)<\\/\\1>/g',
          replaceString: '{{match}}|$1|$<body>|$2|$9|$&',
          trimStrings: ['!'],
        }),
      ],
    );
    expect(run(scripts, [['assistant', '<b>hi!</b>']], false)).toEqual(['<b>hi</b>|b|hi|hi||$&']);
  });

  it('reads a bare pattern, and a slash pattern with its flags', () => {
    const scripts = scriptsOf(
      [],
      [tavern({ findRegex: 'cat', replaceString: 'dog' }), tavern({ findRegex: '/DOG/gi', replaceString: 'fox' })],
    );
    expect(run(scripts, [['user', 'cat cat']], false)).toEqual(['fox cat']);
  });

  it('runs only on the placements and the depths it names', () => {
    const scripts = scriptsOf(
      [],
      [
        tavern({ findRegex: '/x/g', replaceString: 'U', placement: [1] }),
        tavern({ findRegex: '/x/g', replaceString: 'D', minDepth: 1, maxDepth: 2 }),
      ],
    );
    expect(
      run(
        scripts,
        [
          ['assistant', 'x'],
          ['assistant', 'x'],
          ['user', 'x'],
          ['assistant', 'x'],
        ],
        false,
      ),
    ).toEqual(['x', 'D', 'U', 'x']);
  });
});

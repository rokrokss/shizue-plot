// @vitest-environment jsdom
/**
 * The owner's "소악마" prompt preset and its module drawn as RisuAI draws them
 * (wave 8, 2026-10-19): the real `.risup` and `.risum`, read through the import's
 * own readers, their `editdisplay` regex run by our display pass and by RisuAI's
 * transcribed (`risuDisplayOracle`), over the shapes the preset makes Gemini
 * write — reasoning in `<Thoughts>`, then a `# Response` — and over a reader's
 * turn and the module's background. The two must come out as the same text
 * before the markdown: what our planner made of the message, its islands and
 * its prose put back in order and their thoughts folded where the page folds
 * them, against RisuAI's `processScriptFull` then `parseThoughtsAndTools`.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  displayScriptsFromExtensions,
  moduleDisplayScripts,
  orderedWithModules,
  presetDisplayScripts,
  readReaderPresetFile,
  readRisuModule,
} from '@shizue/core';
import { renderProse, type CbsContext } from '../src/lib/cbs';
import { PLAN_LIMITS, renderDisplayPlan, transformDisplay, type DisplayPlan } from '../src/lib/displayScripts';
import { markdownToHtml, renderIsland } from '../src/lib/markdown/html';
import { parseThoughtsAndTools } from '../src/lib/markdown/thoughts';
import { stripTaint } from '../src/lib/taint';
import type { DisplayScript } from '../src/lib/types';
import { risuParseThoughtsAndTools, risuProcessScriptFull, type RisuScript } from './risuDisplayOracle';

/**
 * The files as the owner downloaded them; the jsdom `URL` is not the one `fs`
 * takes, so by path. They are someone else's work, kept out of this public
 * repository in the gitignored `apps/plot/data/fixtures/sokakma/`: the
 * comparison on them runs where they are copied in and is skipped elsewhere,
 * while each rule below runs everywhere on scripts of its own.
 */
const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), '../../../data/fixtures/sokakma');
const present = ['sokakma-module.risum', 'sokakma-preset.risup'].every((file) => existsSync(join(FIXTURES, file)));
const COT = '생각의 사슬';
const TOOL = "도구 '{{tool}}' 호출됨";
const labels = { cot: COT, toolCalled: TOOL };

const module = present
  ? await readRisuModule(new Uint8Array(readFileSync(join(FIXTURES, 'sokakma-module.risum'))))
  : { regex: [], backgroundEmbedding: '' };
const preset = present
  ? await readReaderPresetFile('sokakma-preset.risup', new Uint8Array(readFileSync(join(FIXTURES, 'sokakma-preset.risup'))))
  : { regex: [] };

/** RisuAI's list: `presetRegex`, the character's (none here), the module's. */
const risuScripts = [...preset.regex, ...module.regex] as unknown as RisuScript[];
/** Ours, as the chat page orders what the server sends it. */
const ourScripts: DisplayScript[] = orderedWithModules(
  [],
  [moduleDisplayScripts({ regex: module.regex, displayScripts: displayScriptsFromExtensions({ risuai: { customScripts: module.regex } }) })],
  presetDisplayScripts(preset.regex),
);

const contextOf = (globals: Record<string, string> = {}, chatIndex = 1): CbsContext => ({
  variables: {},
  assets: new Map(),
  turn: 1,
  char: '리아',
  user: '민준',
  globalVariables: globals,
  chatIndex,
  lastMessageId: 1,
});

/** `risuChatParser`'s stand-in: the same engine the planner reads with. */
const parserOf = (ctx: CbsContext) => (text: string): string => renderProse(text, ctx, () => undefined);

/** What RisuAI hands its markdown: the display pass, then the fold. */
function risu(content: string, ctx: CbsContext, chatID = 1): string {
  return risuParseThoughtsAndTools(risuProcessScriptFull(risuScripts, content, 'editdisplay', parserOf(ctx), chatID), COT, TOOL);
}

function planOf(content: string, ctx: CbsContext, background = false): DisplayPlan {
  const plan = transformDisplay({ content, scripts: ourScripts, previousSameRole: '', ...(background ? { background } : {}) }, ctx, PLAN_LIMITS, Date.now);
  expect(plan).not.toBeNull();
  return plan!;
}

/** Ours, put back into one text: each island and each run of prose folded where the page folds it. */
function ours(content: string, ctx: CbsContext, background = false): string {
  const plan = planOf(content, ctx, background);
  const body = plan.body.map((segment) => parseThoughtsAndTools(segment.kind === 'html' ? segment.html : segment.text, labels));
  return stripTaint([...plan.top, body.join(''), ...plan.bottom].filter(Boolean).join('\n'));
}

/** A reply shaped as the preset's response template asks Gemini to write it. */
const REPLY = [
  '<Thoughts>',
  'The user greeted Ria with "안녕". Ria, a 19-year-old barista, should answer playfully.',
  "- Keep her teasing 'tone' and end on a question.",
  '</Thoughts>',
  '# Response',
  '⏱️[2026-10-19 (월) 18:40]',
  '',
  '카페 문이 딸랑 하고 울렸다. 리아가 고개를 들었다.',
  '',
  '"어, 왔어? 기다리다 목 빠지는 줄 알았잖아."',
  '',
  '그녀는 컵을 내려놓으며 §딸깍§ 웃었다.',
  '',
  '리아가 「어서」라고 작게 중얼거렸다.',
  '',
  "'오늘은 좀 늦었네.'",
].join('\n');

/** The top-level blocks RisuAI's markdown makes of a text, as `tag.class: text`. */
function blocksOf(text: string): string[] {
  const doc = new DOMParser().parseFromString(`<body>${markdownToHtml(text)}</body>`, 'text/html');
  return [...doc.body.children]
    .filter((element) => element.textContent!.trim() !== '')
    .map((element) => `${element.tagName.toLowerCase()}${element.className ? `.${element.className}` : ''}: ${element.textContent!.trim()}`);
}

describe.skipIf(!present)('the 소악마 preset and module, against RisuAI', () => {
  it('imports the scripts the files carry', () => {
    expect(preset.regex).toHaveLength(44);
    expect(module.regex).toHaveLength(149);
    // `<cbs>` and the leading line breaks of a template come through the import.
    expect(ourScripts.find((script) => script.in.startsWith('{{#if {{? {{getglobalvar::toggle_stopbracket}}'))?.cbs).toBe(true);
    expect(ourScripts.find((script) => script.in === '#@%#@%')?.out).toBe('\n');
  });

  it('draws a whole reply as RisuAI does, its reasoning gone while the toggle is off', () => {
    const ctx = contextOf();
    const text = ours(REPLY, ctx);
    expect(text).toBe(risu(REPLY, ctx));
    expect(text).not.toContain('$n');
    expect(text).not.toContain('#@%');
    expect(text).not.toContain('The user greeted Ria');
    expect(text).not.toContain('# Response');
    // The dialogue boxed, the clock a badge, the sound a chip — the module's CSS on.
    expect(text).toContain('<div class="regex-quote-block">"어, 왔어?');
    expect(text).toContain('<div class="ts-divider">');
    expect(text).toContain('regex-sound-block');
  });

  it('lays the sound chip out as a block and the coloured word inside its line, as RisuAI’s markdown does', () => {
    const ctx = contextOf();
    const blocks = blocksOf(risu(REPLY, ctx));
    // The chip is a `<div>` between blank lines: its own block between the line's two halves.
    const chip = blocks.findIndex((block) => block.startsWith('div.regex-sound-block'));
    expect(blocks.slice(chip - 1, chip + 2)).toEqual(['p: 그녀는 컵을 내려놓으며', 'div.regex-sound-block: 딸깍', 'p: 웃었다.']);
    // The 「…」 is a `<span>` run of its paragraph.
    expect(blocks).toContain('p: 리아가 「어서」\u200b라고 작게 중얼거렸다.');
    // Ours made the same two islands: the chip a box, the word a span the page keeps in its line.
    const islands = planOf(REPLY, ctx).body.flatMap((segment) => (segment.kind === 'html' ? [stripTaint(segment.html)] : []));
    expect(islands.some((island) => island.includes('<div class="regex-sound-block">'))).toBe(true);
    expect(islands).toContain('<span style="color: #FFB366; ">「어서」</span>&ZeroWidthSpace;');
  });

  it('folds the reasoning as RisuAI does once 🗯추론확인 할래 is on', () => {
    const ctx = contextOf({ toggle_ban_cot_out: '1' });
    const text = ours(REPLY, ctx);
    expect(text).toBe(risu(REPLY, ctx));
    expect(text).toContain(`<details><summary>${COT}</summary>`);
    // Its quotes are the module's placeholders put back, not boxes.
    expect(text).toMatch(/<details><summary>생각의 사슬<\/summary>[\s\S]*The user greeted Ria with "안녕"[\s\S]*<\/details>/);
    expect(text.indexOf('</details>')).toBeLessThan(text.indexOf('카페 문이'));
  });

  it('leaves a reply cut off before its # Response unfolded, as RisuAI does', () => {
    // The owner's reply as it was stored: Gemini ran out of tokens in its reasoning.
    const cut = '<Thoughts>\nThe user responded to Ria\'s frantic bug-plea with a calm "안녕". Ria, a 19';
    const ctx = contextOf();
    const text = ours(cut, ctx);
    expect(text).toBe(risu(cut, ctx));
    expect(text).not.toContain('$n');
    expect(text).not.toContain('<details>');
  });

  it("draws the reader's turn clean", () => {
    const ctx = contextOf({}, 0);
    const text = ours('안녕', ctx);
    expect(text).toBe(risu('안녕', ctx, 0));
    expect(text).not.toContain('$n');
    // The `<Thoughts>` the module opens on every message is unclosed here, and the
    // sanitizer keeps nothing of it: the turn reads as it was written.
    const segments = renderDisplayPlan(planOf('안녕', ctx), (html) => renderIsland(html, labels))!;
    const shown = segments.map((segment) => (segment.kind === 'html' ? segment.html : segment.text)).join('');
    expect(shown.trim()).toBe('안녕');
  });

  it('draws the module background without a stray $n', () => {
    const ctx = contextOf();
    const background = module.backgroundEmbedding!;
    const text = ours(background, ctx, true);
    expect(text).not.toContain('$n');
    expect(text).toContain('.regex-quote-block');
  });
});

/** A RisuAI `editdisplay` script as a card or a module stores it. */
const risuScript = (fields: Partial<RisuScript> & Pick<RisuScript, 'in' | 'out'>): RisuScript => ({
  comment: '',
  type: 'editdisplay',
  ...fields,
});

/** One list through both: the import's reading and our pass, and RisuAI's own. */
function bothWays(raw: RisuScript[], content: string, globals: Record<string, string> = {}): { ours: string; risu: string } {
  const ctx = contextOf(globals);
  const scripts = displayScriptsFromExtensions({ risuai: { customScripts: raw } }) ?? [];
  // No script and no CBS is no plan: the message is drawn as it is, its own fold and all.
  const plan = transformDisplay({ content, scripts, previousSameRole: '' }, ctx, PLAN_LIMITS, Date.now);
  const segments = plan ? plan.body : [{ kind: 'text' as const, text: content }];
  const body = segments.map((segment) => parseThoughtsAndTools(segment.kind === 'html' ? segment.html : segment.text, labels));
  return {
    ours: stripTaint(body.join('')),
    risu: risuParseThoughtsAndTools(risuProcessScriptFull(raw, content, 'editdisplay', parserOf(ctx), 1), COT, TOOL),
  };
}

describe('each rule of RisuAI’s display pass', () => {
  it('reads $n in a template as a line break', () => {
    const { ours, risu } = bothWays([risuScript({ in: '\\[n\\]', out: '<b>줄</b>$n$n다음' })], '앞[n]뒤');
    expect(ours).toBe(risu);
    expect(ours).toBe('앞<b>줄</b>\n\n다음뒤');
  });

  it('puts a line break after a template that ends in >, which the next script matches by', () => {
    const raw = [
      risuScript({ in: 'hp=(\\d+)', out: '<i>$1</i>' }),
      // Only a line start after the block: RisuAI's break is what makes one.
      risuScript({ in: '^뒤', out: '<u>뒤</u>', ableFlag: true, flag: 'gm' }),
    ];
    const { ours, risu } = bothWays(raw, 'hp=5뒤');
    expect(ours).toBe(risu);
    expect(ours).toContain('<i>5</i>\n<u>뒤</u>');
  });

  it('writes no break where <no_end_nl> says so', () => {
    const raw = [
      risuScript({ in: 'hp=(\\d+)', out: '<i>$1</i>', ableFlag: true, flag: 'g<no_end_nl>' }),
      risuScript({ in: '^뒤', out: '<u>뒤</u>', ableFlag: true, flag: 'gm' }),
    ];
    const { ours, risu } = bothWays(raw, 'hp=5뒤');
    expect(ours).toBe(risu);
    expect(ours).toBe('<i>5</i>뒤');
  });

  it('reads a <cbs> pattern as CBS first, so a toggle switches it', () => {
    const raw = [
      risuScript({
        in: '{{#if {{? {{getglobalvar::toggle_strip}}=1}}}}\\s?\\([^)]*\\){{/if}}',
        out: '',
        ableFlag: true,
        flag: 'g<cbs>',
      }),
    ];
    const off = bothWays(raw, '그는(웃으며) 말했다.');
    expect(off.ours).toBe(off.risu);
    expect(off.ours).toBe('그는(웃으며) 말했다.');
    const on = bothWays(raw, '그는(웃으며) 말했다.', { toggle_strip: '1' });
    expect(on.ours).toBe(on.risu);
    expect(on.ours).toBe('그는 말했다.');
  });

  it('keeps the line breaks a template starts with', () => {
    const raw = [risuScript({ in: '#@%', out: '\n' }), risuScript({ in: '^둘', out: '<b>둘</b>', ableFlag: true, flag: 'gm' })];
    const { ours, risu } = bothWays(raw, '하나#@%둘');
    expect(ours).toBe(risu);
    expect(ours).toBe('하나\n<b>둘</b>\n');
  });

  it('runs a preset’s scripts ahead of a module’s, sorted together by <order N>', () => {
    const presetRaw = [
      risuScript({ in: 'a', out: '[preset:$&]' }),
      risuScript({ in: 'b', out: '[preset late:$&]', ableFlag: true, flag: 'g<order -1>' }),
    ];
    const moduleRaw = [risuScript({ in: 'b', out: '[module first:$&]', ableFlag: true, flag: 'g<order 2>' })];
    const ctx = contextOf();
    const scripts = orderedWithModules(
      [],
      [displayScriptsFromExtensions({ risuai: { customScripts: moduleRaw } }) ?? []],
      presetDisplayScripts(presetRaw),
    );
    const plan = transformDisplay({ content: 'ab', scripts, previousSameRole: '' }, ctx, PLAN_LIMITS, Date.now)!;
    const ours = stripTaint(plan.body.map((segment) => (segment.kind === 'html' ? segment.html : segment.text)).join(''));
    expect(ours).toBe(risuProcessScriptFull([...presetRaw, ...moduleRaw], 'ab', 'editdisplay', parserOf(ctx), 1));
    // The module's `<order 2>` first, the preset's own first script next, its `<order -1>` last — over what the others wrote.
    expect(ours).toBe('[preset:a][module first:[preset late:b]]');
  });

  it('reads a script’s span as a run of its line and a box between blank lines as a block of its own', () => {
    const span = bothWays([risuScript({ in: '「([^」]+)」', out: '<span class="s">「$1」</span>' })], '그가 「어서」라고 했다.');
    expect(span.ours).toBe(span.risu);
    // The `>` that ends it writes a break, which markdown makes a `<br>` in the same paragraph.
    expect(blocksOf(span.risu)).toEqual(['p: 그가 「어서」\n라고 했다.']);
    const box = bothWays([risuScript({ in: '§([^§]+)§', out: '\n\n<div class="sound">$1</div>\n\n' })], '내려놓으며 §딸깍§ 웃었다.');
    expect(box.ours).toBe(box.risu);
    expect(blocksOf(box.risu)).toEqual(['p: 내려놓으며', 'div.sound: 딸깍', 'p: 웃었다.']);
  });

  it('folds a <Thoughts> the model closed, in prose or in a script’s block, and leaves an open one', () => {
    const prose = bothWays([], '<Thoughts>\n생각\n</Thoughts>\n답');
    expect(prose.ours).toBe(prose.risu);
    expect(prose.ours).toBe(`<details><summary>${COT}</summary>\n생각\n</details>\n답`);
    const wrapped = bothWays([risuScript({ in: '^[\\s\\S]*$', out: '<Thoughts>$&</Thoughts>' })], '생각');
    expect(wrapped.ours).toBe(wrapped.risu);
    const open = bothWays([], '<Thoughts>\n생각이 끊겼다');
    expect(open.ours).toBe(open.risu);
    expect(open.ours).toBe('<Thoughts>\n생각이 끊겼다');
  });
});

// @vitest-environment jsdom
/**
 * "내 프리셋" in the chat settings: picked per chat in place of the built-in
 * default, managed behind one quiet button, a new one starting as a copy of the
 * default's template, a save that sends the preset whole, and an import that
 * says what it took into which field, and what it left behind.
 *
 * `createElement` rather than JSX, matching chatSettings.test.ts.
 */
import { DEFAULT_PRESET, RISU_DEFAULT_FORMATING_ORDER, type PromptTemplateItem } from '@shizue/core';
import { NextIntlClientProvider } from 'next-intl';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import messages from '../messages/ko.json';
import { ChatSettings } from '../src/components/ChatSettings';
import type { ReaderPreset } from '../src/lib/types';

(globalThis as Record<string, unknown>)['IS_REACT_ACT_ENVIRONMENT'] = true;

let host: HTMLElement;
let root: Root;

/** A preset as a row written before presets were RisuAI's whole: no template, no order. */
const preset = (id: string, name: string): ReaderPreset => ({
  id,
  name,
  main: `${name} 메인`,
  globalNote: '',
  jailbreak: '',
  formatingOrder: null,
  promptTemplate: null,
  groupTemplate: '',
  groupOtherBotRole: 'user',
  toggles: '',
  moduleIntegration: '',
  defaultVariables: '',
  promptSettings: null,
  regex: [],
  createdAt: '2026-10-15T00:00:00.000Z',
  updatedAt: '2026-10-15T00:00:00.000Z',
});

function render(
  presets: ReaderPreset[],
  options: { selected?: string | null; patches?: unknown[]; lists?: ReaderPreset[][] } = {},
): void {
  act(() => {
    root.render(
      createElement(NextIntlClientProvider, {
        locale: 'ko',
        messages,
        children: createElement(ChatSettings, {
          binding: { main: 'm1', sub: null },
          presets: [{ id: 'm1', name: '모델 하나', format: 'openai-chat', endpoint: null, model: 'one', credentialId: null, params: {}, capabilities: {} }],
          defaults: { main: null, sub: null },
          personaId: null,
          personas: [],
          readerPresetId: options.selected ?? null,
          readerPresets: presets,
          onReaderPresetsChange: (next) => void options.lists?.push(next),
          disabled: false,
          onChange: (patch) => void options.patches?.push(patch),
        }),
      }),
    );
  });
}

const button = (name: string): HTMLButtonElement | undefined =>
  [...document.querySelectorAll('button')].find(
    (node) => node.textContent?.trim() === name || node.getAttribute('aria-label') === name,
  );

const manager = (): Element => host.querySelector('[data-testid="reader-preset-manager"]')!;

/** The field a caption names (`Field`: the caption is the label's first span). */
const labelled = (caption: string): HTMLLabelElement | undefined =>
  [...manager().querySelectorAll('label')].find((label) => label.querySelector('span > span')?.textContent === caption);

const area = (caption: string): HTMLTextAreaElement => labelled(caption)!.querySelector('textarea')!;

const noticeLines = (): (string | null)[] =>
  [...host.querySelectorAll('[data-testid="reader-preset-import-notice"] li')].map((item) => item.textContent);

async function click(node: HTMLElement): Promise<void> {
  await act(async () => {
    node.click();
  });
}

async function type(node: HTMLInputElement | HTMLTextAreaElement, value: string): Promise<void> {
  const prototype = node instanceof HTMLInputElement ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(prototype, 'value')!.set!;
  await act(async () => {
    setter.call(node, value);
    node.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

async function upload(file: File): Promise<void> {
  const input = document.querySelector<HTMLInputElement>('[data-testid="reader-preset-import-input"]')!;
  Object.defineProperty(input, 'files', { configurable: true, value: [file] });
  await act(async () => {
    input.dispatchEvent(new Event('change', { bubbles: true }));
  });
  // The file is read and parsed off the event.
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

/** Saves the draft against a stubbed API and gives back what was sent. */
async function save(answer: ReaderPreset): Promise<{ url: string; method: string; body: Record<string, unknown> }> {
  const fetchMock = vi.fn(async () => new Response(JSON.stringify(answer), { status: 200 }));
  vi.stubGlobal('fetch', fetchMock);
  await click(button('저장')!);
  expect(fetchMock).toHaveBeenCalledTimes(1);
  const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
  return { url, method: String(init.method), body: JSON.parse(String(init.body)) as Record<string, unknown> };
}

/** A template as JSON carries it: a key whose value is undefined is not sent. */
const asSent = (items: readonly PromptTemplateItem[]): unknown => JSON.parse(JSON.stringify(items));

beforeEach(() => {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

describe('the stacked field', () => {
  it('picks one of the reader’s presets for the chat, or the built-in default', () => {
    const patches: unknown[] = [];
    render([preset('a', '담백하게'), preset('b', '길게')], { selected: 'b', patches });
    const select = host.querySelector<HTMLSelectElement>('[data-testid="reader-presets"] select')!;
    expect(select.labels?.[0]?.textContent).toBe('내 프리셋');
    expect([...select.options].map((option) => option.textContent)).toEqual(['기본 (OAI2)', '담백하게', '길게']);
    expect(select.value).toBe('b');
    act(() => {
      select.value = '';
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    expect(patches).toEqual([{ readerPresetId: null }]);
  });

  it('keeps the manager behind one button, and saves a new preset as a copy of the default’s template', async () => {
    const lists: ReaderPreset[][] = [];
    render([], { lists });
    expect(host.querySelector('select[id$="-pick"]')).toBeNull();
    expect(host.querySelector('[data-testid="reader-preset-manager"]')).toBeNull();

    await click(button('내 프리셋 관리')!);
    expect(button('내 프리셋 관리')).toBeUndefined();
    await click(button('새 프리셋')!);

    const template = DEFAULT_PRESET.promptTemplate!;
    const name = manager().querySelector('input')!;
    expect(name.value).toBe('새 프리셋');
    expect(manager().querySelectorAll('[data-testid="reader-preset-template"] > li')).toHaveLength(template.length);
    // No legacy texts beside a template: the template is the prompt.
    expect(labelled('메인 프롬프트')).toBeUndefined();

    await type(name, '내 문체');
    // The first item is the main prompt's text, the second the description's inner format.
    const [first, second] = manager().querySelectorAll('textarea');
    expect(first!.value).toBe((template[0] as { text: string }).text);
    await type(first!, '내 메인');
    await type(second!, '[설정]\n{{slot}}');
    const created = { ...preset('c', '내 문체'), promptTemplate: [] };
    const sent = await save(created);

    expect(sent.url).toBe('/api/reader-presets');
    expect(sent.method).toBe('POST');
    expect(sent.body).toEqual({
      name: '내 문체',
      main: '',
      globalNote: '',
      jailbreak: '',
      formatingOrder: null,
      // Every item where it stood, only the two edited texts changed.
      promptTemplate: asSent(
        template.map((item, at) =>
          at === 0 ? { ...item, text: '내 메인' } : at === 1 ? { ...item, innerFormat: '[설정]\n{{slot}}' } : item,
        ),
      ),
      groupTemplate: '',
      groupOtherBotRole: 'user',
      toggles: '',
      moduleIntegration: '',
      defaultVariables: '',
      promptSettings: null,
      regex: null,
    });
    expect(lists).toEqual([[created]]);
    // The draft was a copy: the built-in default every other chat runs is unchanged.
    expect((DEFAULT_PRESET.promptTemplate![0] as { text: string }).text).not.toBe('내 메인');
    expect(DEFAULT_PRESET.promptTemplate![1]).not.toHaveProperty('innerFormat', '[설정]\n{{slot}}');
  });

  it('edits a preset without a template in RisuAI’s three texts, and keeps it one', async () => {
    const old = { ...preset('a', '예전'), globalNote: '노트' };
    render([old]);
    await click(button('내 프리셋 관리')!);
    await click(button('예전 수정')!);

    expect(manager().querySelector('[data-testid="reader-preset-template"]')).toBeNull();
    expect(area('메인 프롬프트').value).toBe('예전 메인');
    expect(area('탈옥 프롬프트').value).toBe('');
    expect(area('글로벌 노트').value).toBe('노트');
    await type(area('탈옥 프롬프트'), '탈옥 글');
    const sent = await save(old);

    expect(sent.url).toBe('/api/reader-presets/a');
    expect(sent.method).toBe('PUT');
    expect(sent.body).toMatchObject({
      main: '예전 메인',
      jailbreak: '탈옥 글',
      globalNote: '노트',
      // Still RisuAI's preset without a template, in its default order.
      formatingOrder: null,
      promptTemplate: null,
    });
  });

  it('imports a SillyTavern preset’s prompts where ST sends them, and says which went where', async () => {
    render([]);
    await click(button('내 프리셋 관리')!);
    const st = {
      chat_completion_source: 'openai',
      prompts: [
        { identifier: 'main', name: 'Main Prompt', content: 'ST 메인' },
        { identifier: 'jailbreak', name: 'Post-History Instructions', content: 'PHI 지시' },
        { identifier: 'nsfw', name: 'Auxiliary Prompt', content: 'AUX 지시' },
        { identifier: 'x', name: '문체', content: '짧게' },
        { identifier: 'off', name: '꺼짐', content: 'OFF-TEXT' },
      ],
      prompt_order: [
        {
          character_id: 100000,
          order: [
            { identifier: 'main', enabled: true },
            { identifier: 'nsfw', enabled: true },
            { identifier: 'jailbreak', enabled: true },
            { identifier: 'x', enabled: true },
            { identifier: 'off', enabled: false },
          ],
        },
      ],
    };
    await upload(new File([JSON.stringify(st)], 'Celia.json', { type: 'application/json' }));

    const notice = host.querySelector('[data-testid="reader-preset-import-notice"]')!;
    expect(notice.textContent).toContain('SillyTavern 프리셋에서 가져왔습니다');
    expect(noticeLines()).toEqual([
      'Main Prompt → 메인 프롬프트',
      'Auxiliary Prompt → 메인 프롬프트',
      'Post-History Instructions → 글로벌 노트',
      '그 밖의 프롬프트 1개는 보내지 않습니다: 문체',
      '모델·샘플링 등 나머지 설정도 가져오지 않았습니다.',
    ]);
    expect(manager().querySelector('input')!.value).toBe('Celia');
    expect(area('메인 프롬프트').value).toBe('ST 메인\n\nAUX 지시');
    expect(area('탈옥 프롬프트').value).toBe('');
    expect(area('글로벌 노트').value).toBe('PHI 지시');
    // A prompt the order keeps off is not sent by ST, and not taken.
    expect(host.innerHTML).not.toContain('OFF-TEXT');

    const sent = await save(preset('c', 'Celia'));
    expect(sent.body).toMatchObject({ promptTemplate: null, formatingOrder: [...RISU_DEFAULT_FORMATING_ORDER] });
  });

  it('takes a RisuAI preset’s toggles, module integration and default variables into their fields, and says so', async () => {
    render([]);
    await click(button('내 프리셋 관리')!);
    const risu = {
      name: '토글 프리셋',
      mainPrompt: '{{#when::toggle::rain}}비{{/when}}',
      customPromptTemplateToggle: 'rain=비 오는 날',
      moduleIntergration: 'weather, ui',
      templateDefaultVariables: 'hp=10',
    };
    await upload(new File([JSON.stringify(risu)], 'risu.json', { type: 'application/json' }));
    expect(noticeLines()).toEqual([
      '메인 프롬프트 → 메인 프롬프트',
      '토글 → 토글',
      '모듈 통합 → 모듈 통합 (weather, ui)',
      '기본 변수 → 기본 변수',
    ]);
    expect(area('메인 프롬프트').value).toBe('{{#when::toggle::rain}}비{{/when}}');
    expect(area('토글').value).toBe('rain=비 오는 날');
    expect(area('기본 변수').value).toBe('hp=10');
    expect([...manager().querySelectorAll('input')].map((input) => input.value)).toEqual(['토글 프리셋', 'weather, ui']);
  });

  it('names a RisuAI field it took by RisuAI’s name for it', async () => {
    render([]);
    await click(button('내 프리셋 관리')!);
    const risu = { name: '리스', mainPrompt: '메인', jailbreak: '탈옥 글', globalNote: '' };
    await upload(new File([JSON.stringify(risu)], 'risu.json', { type: 'application/json' }));
    expect(noticeLines()).toEqual(['메인 프롬프트 → 메인 프롬프트', '탈옥 프롬프트 → 탈옥 프롬프트']);
    expect(area('탈옥 프롬프트').value).toBe('탈옥 글');
  });

  it('keeps a RisuAI preset’s template whole, with only its texts to edit, and saves it so', async () => {
    render([]);
    await click(button('내 프리셋 관리')!);
    const promptTemplate = [
      { type: 'plain', type2: 'main', text: '메인 글', role: 'system', name: '시작' },
      { type: 'description', innerFormat: '[설정]\n{{slot}}' },
      { type: 'chat', rangeStart: 0, rangeEnd: -2 },
      { type: 'cot', type2: 'normal', text: '생각 글', role: 'system', name: '생각하기' },
      { type: 'chat', rangeStart: -2, rangeEnd: 'end' },
      { type: 'jailbreak', type2: 'normal', text: '탈옥 글', role: 'bot' },
    ];
    const risu = { name: '템플릿', mainPrompt: '쓰이지 않는 메인', promptTemplate, temperature: 80 };
    await upload(new File([JSON.stringify(risu)], 'risu.json', { type: 'application/json' }));

    expect(noticeLines()).toEqual([
      '프롬프트 템플릿 → 프롬프트 템플릿 (항목 6개)',
      '시작 → 프롬프트 템플릿',
      '탈옥 프롬프트 → 프롬프트 템플릿',
      '그 밖의 프롬프트 1개는 보내지 않습니다: 생각하기',
      '모델·샘플링 등 나머지 설정도 가져오지 않았습니다.',
    ]);
    const items = [...manager().querySelectorAll('[data-testid="reader-preset-template"] > li')];
    expect(items).toHaveLength(6);
    // The chat's stretches are shown, not edited; the chain of thought is kept but not sent.
    expect(items[2]!.querySelector('textarea')).toBeNull();
    expect(items[2]!.textContent).toBe('대화 기록 · 0 ~ -2');
    expect(items[4]!.textContent).toBe('대화 기록 · -2 ~ 끝');
    expect(items[3]!.querySelector('textarea')).toBeNull();
    expect(items[0]!.querySelector('textarea')!.value).toBe('메인 글');
    expect(items[1]!.querySelector('textarea')!.value).toBe('[설정]\n{{slot}}');

    await type(items[5]!.querySelector('textarea')!, '바꾼 탈옥');
    const sent = await save(preset('c', '템플릿'));
    // Kept beside the template, as RisuAI keeps it, though not read.
    expect(sent.body).toMatchObject({ name: '템플릿', main: '쓰이지 않는 메인' });
    expect(sent.body['promptTemplate']).toEqual(
      promptTemplate.map((item, at) => (at === 5 ? { ...item, text: '바꾼 탈옥' } : item)),
    );
  });

  it('says so when a file is not a preset', async () => {
    render([]);
    await click(button('내 프리셋 관리')!);
    await upload(new File([JSON.stringify({ spec: 'chara_card_v2', data: {} })], 'card.json'));
    expect(host.textContent).toContain('RisuAI나 SillyTavern의 프리셋 파일이 아닙니다.');
  });
});

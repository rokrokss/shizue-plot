// @vitest-environment jsdom
/**
 * "내 프리셋" in the chat settings: picked per chat, managed behind one quiet
 * button, and an import that says what it took into which field, and what it
 * left behind.
 *
 * `createElement` rather than JSX, matching chatSettings.test.ts.
 */
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

const preset = (id: string, name: string): ReaderPreset => ({
  id,
  name,
  main: `${name} 메인`,
  globalNote: '',
  toggles: '',
  moduleIntegration: '',
  createdAt: '2026-10-15T00:00:00.000Z',
  updatedAt: '2026-10-15T00:00:00.000Z',
});

function render(
  presets: ReaderPreset[],
  options: { stacked?: boolean; selected?: string | null; patches?: unknown[]; lists?: ReaderPreset[][] } = {},
): void {
  act(() => {
    root.render(
      createElement(NextIntlClientProvider, {
        locale: 'ko',
        messages,
        children: createElement(ChatSettings, {
          model: 'm1',
          subModel: null,
          reasoningEffort: null,
          preset: 'standard',
          personaId: null,
          models: [{ id: 'm1', label: '모델 하나' }],
          presets: [],
          personas: [],
          readerPresetId: options.selected ?? null,
          readerPresets: presets,
          onReaderPresetsChange: (next) => void options.lists?.push(next),
          disabled: false,
          stacked: options.stacked ?? true,
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
  it('picks one of the reader’s presets for the chat, or none', () => {
    const patches: unknown[] = [];
    render([preset('a', '담백하게'), preset('b', '길게')], { selected: 'b', patches });
    const select = host.querySelector<HTMLSelectElement>('[data-testid="reader-presets"] select')!;
    expect(select.labels?.[0]?.textContent).toBe('내 프리셋');
    expect([...select.options].map((option) => option.textContent)).toEqual(['쓰지 않음', '담백하게', '길게']);
    expect(select.value).toBe('b');
    act(() => {
      select.value = '';
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    expect(patches).toEqual([{ readerPresetId: null }]);
  });

  it('keeps the manager behind one button, and saves a new preset', async () => {
    const lists: ReaderPreset[][] = [];
    render([], { lists });
    expect(host.querySelector('select[id$="-pick"]')).toBeNull();
    expect(host.querySelector('[data-testid="reader-preset-manager"]')).toBeNull();

    await click(button('내 프리셋 관리')!);
    expect(button('내 프리셋 관리')).toBeUndefined();
    await click(button('새 프리셋')!);

    const created = preset('c', '내 문체');
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(created), { status: 201 }));
    vi.stubGlobal('fetch', fetchMock);
    const manager = host.querySelector('[data-testid="reader-preset-manager"]')!;
    await type(manager.querySelector('input')!, '내 문체');
    await type(manager.querySelectorAll('textarea')[0]!, '내 문체 메인');
    await click(button('저장')!);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('/api/reader-presets');
    expect(init.method).toBe('POST');
    expect(JSON.parse(String(init.body))).toEqual({
      name: '내 문체',
      main: '내 문체 메인',
      globalNote: '',
      toggles: '',
      moduleIntegration: '',
    });
    expect(lists).toEqual([[created]]);
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
    expect([...notice.querySelectorAll('li')].map((item) => item.textContent)).toEqual([
      'Main Prompt → 메인 지시 추가',
      'Auxiliary Prompt → 메인 지시 추가',
      'Post-History Instructions → 글로벌 노트',
      '그 밖의 프롬프트 1개는 가져오지 않았습니다: 문체',
      '모델·샘플링 등 나머지 설정도 가져오지 않았습니다.',
    ]);
    const manager = host.querySelector('[data-testid="reader-preset-manager"]')!;
    expect(manager.querySelector('input')!.value).toBe('Celia');
    expect([...manager.querySelectorAll('textarea')].map((area) => area.value)).toEqual(['ST 메인\n\nAUX 지시', 'PHI 지시', '']);
    // A prompt the order keeps off is not sent by ST, and not taken.
    expect(host.innerHTML).not.toContain('OFF-TEXT');
  });

  it('takes a RisuAI preset’s toggles and module integration into their fields, and says so', async () => {
    render([]);
    await click(button('내 프리셋 관리')!);
    const risu = {
      name: '토글 프리셋',
      mainPrompt: '{{#when::toggle::rain}}비{{/when}}',
      customPromptTemplateToggle: 'rain=비 오는 날',
      moduleIntergration: 'weather, ui',
    };
    await upload(new File([JSON.stringify(risu)], 'risu.json', { type: 'application/json' }));
    const notice = host.querySelector('[data-testid="reader-preset-import-notice"]')!;
    expect([...notice.querySelectorAll('li')].map((item) => item.textContent)).toEqual([
      '메인 프롬프트 → 메인 지시 추가',
      '토글 → 토글',
      '모듈 통합 → 모듈 통합 (weather, ui)',
    ]);
    const manager = host.querySelector('[data-testid="reader-preset-manager"]')!;
    expect([...manager.querySelectorAll('textarea')].map((area) => area.value)).toEqual([
      '{{#when::toggle::rain}}비{{/when}}',
      '',
      'rain=비 오는 날',
    ]);
    expect([...manager.querySelectorAll('input')].map((input) => input.value)).toEqual(['토글 프리셋', 'weather, ui']);
  });

  it('names a RisuAI field it took by RisuAI’s name for it', async () => {
    render([]);
    await click(button('내 프리셋 관리')!);
    const risu = { name: '리스', mainPrompt: '메인', jailbreak: '탈옥 글', globalNote: '' };
    await upload(new File([JSON.stringify(risu)], 'risu.json', { type: 'application/json' }));
    const notice = host.querySelector('[data-testid="reader-preset-import-notice"]')!;
    expect([...notice.querySelectorAll('li')].map((item) => item.textContent)).toEqual([
      '메인 프롬프트 → 메인 지시 추가',
      '탈옥 프롬프트 → 글로벌 노트',
    ]);
  });

  it('says so when a file is not a preset', async () => {
    render([]);
    await click(button('내 프리셋 관리')!);
    await upload(new File([JSON.stringify({ spec: 'chara_card_v2', data: {} })], 'card.json'));
    expect(host.textContent).toContain('RisuAI나 SillyTavern의 프리셋 파일이 아닙니다.');
  });
});

describe('the compact row', () => {
  it('is one quiet button that opens the field in a sheet', async () => {
    render([preset('a', '담백하게')], { stacked: false, selected: 'a' });
    expect(host.querySelector('[data-testid="reader-presets"]')).toBeNull();
    await click(button('내 프리셋 · 담백하게')!);
    const sheet = document.querySelector('[data-testid="bottom-sheet"]')!;
    expect(sheet.getAttribute('aria-label')).toBe('내 프리셋');
    expect(sheet.querySelector<HTMLSelectElement>('[data-testid="reader-presets"] select')!.value).toBe('a');
  });
});

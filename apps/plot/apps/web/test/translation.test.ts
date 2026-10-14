// @vitest-environment jsdom
/**
 * The language modes on the page: what a message body asks to have translated
 * and how it draws the answer, the chat's translator and its cache, and the
 * settings that pick a mode.
 *
 * `createElement` rather than JSX, as the other mounted suites.
 */
import { NextIntlClientProvider } from 'next-intl';
import { act, createElement, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import messages from '../messages/ko.json';
import type { DisplayContext } from '../src/lib/displayScripts';
import type { BodyTranslation } from '../src/lib/translation';
import type { DisplayScript, PublicMember } from '../src/lib/types';

/** The planner is a module singleton and there is no `Worker` here, so it is replaced. */
const answers: ((plan: unknown) => void)[] = [];
vi.mock('@/lib/displayPlanner', () => ({
  displayPlanner: {
    plan: () => new Promise((resolve) => answers.push(resolve)),
    cached: () => undefined,
    warm: () => true,
    stop: () => undefined,
  },
}));

const { MessageBody } = await import('../src/components/MessageBody');
const { ChatSettings } = await import('../src/components/ChatSettings');
const { ChatTranslator } = await import('../src/lib/translation');
const { transformDisplay, PLAN_LIMITS } = await import('../src/lib/displayScripts');

(globalThis as Record<string, unknown>)['IS_REACT_ACT_ENVIRONMENT'] = true;

let host: HTMLElement;
let root: Root;

function render(element: ReactElement): void {
  act(() => {
    root.render(createElement(NextIntlClientProvider, { locale: 'ko', messages, children: element }));
  });
}

beforeEach(() => {
  answers.length = 0;
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

const roster: PublicMember[] = [{ id: 'm1', name: '리안', avatarUrl: null } as PublicMember];

/** A row's translation, recording what the body reports. */
function translation(texts: Record<string, string> = {}): { body: BodyTranslation; reported: string[][] } {
  const reported: string[][] = [];
  return {
    reported,
    body: { texts: new Map(Object.entries(texts)), report: (_body, shown) => void reported.push([...shown]) },
  };
}

describe('a translated message body', () => {
  it('asks about its prose once it has settled, and draws what arrived under the speaker it names', () => {
    const content = '리안: 안녕하세요. *웃는다*\n\n![](https://x.example/a.png)';
    const streaming = translation();
    render(createElement(MessageBody, { content, roster, mode: 'reply', streaming: true, translation: streaming.body }));
    expect(streaming.reported).toEqual([]);

    const settled = translation();
    render(createElement(MessageBody, { key: 'settled', content, roster, mode: 'reply', translation: settled.body }));
    expect(settled.reported.at(-1)).toEqual(['안녕하세요. *웃는다*']);

    const arrived = translation({ '안녕하세요. *웃는다*': 'Hello. *smiles*' });
    render(createElement(MessageBody, { key: 'arrived', content, roster, mode: 'reply', translation: arrived.body }));
    const speaker = host.querySelector('[data-testid="speech-character"]')!;
    expect(speaker.getAttribute('data-speaker')).toBe('리안');
    expect(speaker.textContent).toContain('Hello.');
    expect(speaker.querySelector('em')?.textContent).toBe('smiles');
    expect(host.textContent).not.toContain('안녕하세요');
  });

  it('translates the text of a display script island and never its markup', async () => {
    const script: DisplayScript = { in: '\\[status\\] hp=(\\d+)', out: '<div class="hp" title="체력">체력 $1</div>', order: 0, enabled: true };
    const scripts = [script];
    const display: DisplayContext = {
      scripts,
      variables: {},
      assets: new Map(),
      relationship: null,
      turn: 1,
      char: '아리아',
      user: '민준',
    };
    const content = '[status] hp=50\n\n검을 뽑았다.';
    const plan = transformDisplay({ content, scripts, previousSameRole: '' }, display, PLAN_LIMITS, Date.now);

    const asked = translation();
    render(createElement(MessageBody, { content, display, translation: asked.body }));
    await act(async () => {
      answers.shift()?.(plan);
      await Promise.resolve();
    });
    expect(asked.reported.at(-1)).toEqual(['체력 50', '검을 뽑았다.']);

    const arrived = translation({ '체력 50': 'HP 50', '검을 뽑았다.': 'He drew his sword.' });
    render(createElement(MessageBody, { key: 'arrived', content, display, translation: arrived.body }));
    await act(async () => {
      answers.shift()?.(plan);
      await Promise.resolve();
    });
    const island = host.querySelector('.x-risu-hp, .hp, [class*="hp"]');
    expect(island?.textContent).toBe('HP 50');
    expect(island?.getAttribute('title')).toBe('체력');
    expect(host.textContent).toContain('He drew his sword.');
  });
});

describe('the chat translator', () => {
  it('reads the cache once and asks only for what it does not hold, a request each', async () => {
    const calls: { url: string; body?: unknown }[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        calls.push({ url, ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}) });
        const answer = url.includes('/translations?')
          ? { translations: { a: { 'Hello.': '안녕.' } } }
          : { texts: { 'Bye.': '잘 가.' } };
        return new Response(JSON.stringify(answer), { status: 200, headers: { 'content-type': 'application/json' } });
      }),
    );
    const translator = new ChatTranslator('c1', 'ko');
    expect([...(await translator.translate('a', ['Hello.']))]).toEqual([['Hello.', '안녕.']]);
    expect((await translator.translate('b', ['Bye.'])).get('Bye.')).toBe('잘 가.');
    expect((await translator.translate('b', ['Bye.'])).get('Bye.')).toBe('잘 가.');
    expect(calls.map((call) => call.url)).toEqual([
      '/api/chats/c1/translations?language=ko',
      '/api/chats/c1/messages/b/translation',
    ]);
    expect(calls[1]!.body).toEqual({ language: 'ko', texts: ['Bye.'] });
  });
});

describe('the language mode settings', () => {
  function renderSettings(language: Record<string, unknown>, patches: unknown[] = []): HTMLSelectElement[] {
    render(
      createElement(ChatSettings, {
        model: 'm1',
        subModel: null,
        reasoningEffort: null,
        preset: 'standard',
        personaId: null,
        models: [{ id: 'm1', label: '모델 하나' }],
        presets: [],
        personas: [],
        disabled: false,
        stacked: true,
        language: { settings: {}, plotLanguage: 'en', locale: 'ko', recommended: false, ...language } as never,
        onChange: (patch: unknown) => void patches.push(patch),
      }) as ReactElement,
    );
    return [...host.querySelectorAll('select')];
  }
  const modeSelect = () => host.querySelector<HTMLSelectElement>('select[id$="-languageMode"]')!;

  it('defaults to the reply-language mode for a work in another language, and to as-written for one in the reader own', () => {
    renderSettings({});
    expect(modeSelect().options[0]!.textContent).toBe('자동 (답장 언어 지시)');
    expect(host.textContent).toContain('모델이 한국어로 답합니다');
    // A work in the page's own language has nothing to choose between.
    renderSettings({ plotLanguage: 'ko' });
    expect(modeSelect()).toBeNull();
    // Unless the reader picked something there, which they can take back.
    renderSettings({ plotLanguage: 'ko', settings: { mode: 'instruct' } });
    expect(modeSelect().options[0]!.textContent).toBe('자동 (원문 그대로)');
    expect(host.textContent).toContain('이 작품은 한국어로 쓰여 있어');
  });

  it('recommends the translate mode for a card that reads the model output, quietly, and saves the pick', () => {
    const patches: unknown[] = [];
    renderSettings({ recommended: true }, patches);
    expect(host.querySelector('[data-testid="translate-recommended"]')?.textContent).toBe('이 카드는 번역 모드를 권장해요');
    // Nothing is switched for the reader.
    expect(patches).toEqual([]);
    act(() => {
      const select = modeSelect();
      select.value = 'translate';
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    expect(patches).toEqual([{ translation: { mode: 'translate' } }]);

    renderSettings({ recommended: true, settings: { mode: 'translate' } });
    expect(host.querySelector('[data-testid="translate-recommended"]')).toBeNull();
    // The input translation is the translate mode's.
    expect(host.textContent).toContain('내 메시지를 English로 번역해서 보내기');
    renderSettings({ recommended: false });
    expect(host.querySelector('[data-testid="translate-recommended"]')).toBeNull();
    expect(host.textContent).not.toContain('내 메시지를');
  });
});

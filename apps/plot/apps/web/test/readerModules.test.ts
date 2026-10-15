// @vitest-environment jsdom
/**
 * The chat's RisuAI modules in its settings: the toggles the modules and the
 * members declare (`ModuleToggles`), written as the reader's `toggle_<key>`
 * globals as RisuAI writes them, and the reader's own module library
 * (`ReaderModules`) — turned on here or everywhere, and an import that wants
 * low-level access asked first, as RisuAI asks.
 *
 * `createElement` rather than JSX, matching the other component tests.
 */
import { NextIntlClientProvider } from 'next-intl';
import { act, createElement, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import messages from '../messages/ko.json';
import type { ReaderModuleSummary } from '../src/lib/types';

(globalThis as Record<string, unknown>)['IS_REACT_ACT_ENVIRONMENT'] = true;

const uploads: { path: string; fields: Record<string, string> }[] = [];
const sends: { method: string; path: string; body: unknown }[] = [];
let uploadAnswer: (fields: Record<string, string>) => Promise<unknown>;

vi.mock('@/lib/api', async (importOriginal) => {
  const original = await importOriginal<typeof import('../src/lib/api')>();
  return {
    ...original,
    apiUpload: (path: string, _file: File, fields: Record<string, string> = {}) => {
      uploads.push({ path, fields });
      return uploadAnswer(fields);
    },
    apiSend: (method: string, path: string, body?: unknown) => {
      sends.push({ method, path, body });
      return Promise.resolve({});
    },
  };
});

const { ApiError } = await import('../src/lib/api');
const { ModuleToggles } = await import('../src/components/ModuleToggles');
const { ReaderModules } = await import('../src/components/ReaderModules');

let host: HTMLElement;
let root: Root;

async function render(node: ReactNode): Promise<void> {
  await act(async () => {
    root.render(createElement(NextIntlClientProvider, { locale: 'ko', messages, children: node }));
  });
}

beforeEach(() => {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  uploads.length = 0;
  sends.length = 0;
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.restoreAllMocks();
});

describe('ModuleToggles', () => {
  it('draws RisuAI’s toggles and writes each as the reader’s toggle_ global', async () => {
    const set: [string, string][] = [];
    const onSet = async (name: string, value: string) => void set.push([name, value]);
    await render(
      createElement(ModuleToggles, {
        text: 'rain=비 오는 날\nsky=하늘=select=맑음,흐림\n=날씨 설명=caption\ng=묶음=group\ninner=안쪽\n==groupEnd',
        values: { toggle_rain: '1', toggle_sky: 'null' },
        onSet,
      }),
    );
    const section = host.querySelector('[data-testid="chat-toggles"]')!;
    expect(section.textContent).toContain('날씨 설명');
    expect(section.querySelector('details summary')!.textContent).toBe('묶음');
    const rain = [...section.querySelectorAll('label')].find((label) => label.textContent === '비 오는 날')!.querySelector('input')!;
    expect(rain.checked).toBe(true);
    await act(async () => rain.click());
    const sky = section.querySelector('select')!;
    // A select's value is the chosen option's index, as RisuAI stores it.
    expect([...sky.options].map((option) => [option.value, option.textContent])).toEqual([
      ['0', '맑음'],
      ['1', '흐림'],
    ]);
    await act(async () => {
      sky.value = '1';
      sky.dispatchEvent(new Event('change', { bubbles: true }));
    });
    expect(set).toEqual([
      ['toggle_rain', '0'],
      ['toggle_sky', '1'],
    ]);
  });

  it('draws nothing where nothing is declared', async () => {
    await render(createElement(ModuleToggles, { text: '\n\n', values: {}, onSet: async () => undefined }));
    expect(host.querySelector('[data-testid="chat-toggles"]')).toBeNull();
  });
});

describe('ReaderModules', () => {
  const rain: ReaderModuleSummary = {
    id: 'rm-1',
    name: '비 모듈',
    description: '독자의 비.',
    enabledGlobally: false,
    loreCount: 1,
    regexCount: 2,
    triggerCount: 1,
    displayScriptCount: 1,
    assetCount: 1,
    background: true,
    toggles: true,
    lowLevelAccess: true,
    scripts: true,
    importedFrom: { fileName: 'rain.risum', sha256: 'x', importedAt: '2026-10-15T00:00:00.000Z' },
    createdAt: '2026-10-15T00:00:00.000Z',
  };

  it('turns a module on in this chat, and greys that switch while it is on everywhere', async () => {
    const lists: string[][] = [];
    const props = { chatIds: [] as string[], onChatIds: async (ids: string[]) => void lists.push(ids), onChange: async () => undefined };
    await render(createElement(ReaderModules, { ...props, library: [rain] }));
    const [here, everywhere] = [...host.querySelectorAll<HTMLInputElement>('[data-testid="reader-module"] input[type="checkbox"]')];
    expect(here!.disabled).toBe(false);
    await act(async () => here!.click());
    expect(lists).toEqual([['rm-1']]);
    await act(async () => everywhere!.click());
    expect(sends).toEqual([{ method: 'PATCH', path: '/api/reader-modules/rm-1', body: { enabledGlobally: true } }]);

    await render(createElement(ReaderModules, { ...props, library: [{ ...rain, enabledGlobally: true }] }));
    const [greyed] = [...host.querySelectorAll<HTMLInputElement>('[data-testid="reader-module"] input[type="checkbox"]')];
    expect(greyed!.checked).toBe(true);
    expect(greyed!.disabled).toBe(true);
  });

  it('asks before importing a module that wants low-level access, and imports it only on a yes', async () => {
    uploadAnswer = async (fields) => {
      if (fields['confirmLowLevelAccess'] !== 'true') {
        throw new ApiError(409, 'low_level_access_unconfirmed', 'confirm');
      }
      return { importWarnings: [] };
    };
    let changes = 0;
    await render(
      createElement(ReaderModules, {
        library: [],
        chatIds: [],
        onChatIds: async () => undefined,
        onChange: async () => void (changes += 1),
      }),
    );
    const input = host.querySelector<HTMLInputElement>('[data-testid="reader-module-file"]')!;
    const pick = async () => {
      Object.defineProperty(input, 'files', { value: [new File(['x'], 'rain.risum')], configurable: true });
      await act(async () => input.dispatchEvent(new Event('change', { bubbles: true })));
    };

    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    await pick();
    expect(confirm).toHaveBeenCalledWith(messages.chat.readerModuleLowLevelConfirm);
    expect(uploads.map((upload) => upload.fields)).toEqual([{}]);
    expect(changes).toBe(0);

    confirm.mockReturnValue(true);
    await pick();
    expect(uploads.map((upload) => upload.fields)).toEqual([{}, {}, { confirmLowLevelAccess: 'true' }]);
    expect(changes).toBe(1);
  });
});

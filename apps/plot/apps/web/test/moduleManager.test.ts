// @vitest-environment jsdom
/**
 * The studio's RisuAI modules (`ModuleManager`): the list says what each module
 * brought, a picked file goes up as a module, and a removal asks first — each
 * answered with the plot's owner view, which the studio takes the list from.
 *
 * `createElement` rather than JSX, matching the other component tests.
 */
import { NextIntlClientProvider } from 'next-intl';
import { act, createElement, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import messages from '../messages/ko.json';
import type { PlotDetail, PlotModuleSummary } from '../src/lib/types';

(globalThis as Record<string, unknown>)['IS_REACT_ACT_ENVIRONMENT'] = true;

const uploads: { path: string; file: File }[] = [];
const sends: { method: string; path: string }[] = [];
let answer: () => Promise<PlotDetail>;

vi.mock('@/lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/lib/api')>()),
  apiUpload: (path: string, file: File) => {
    uploads.push({ path, file });
    return answer();
  },
  apiSend: (method: string, path: string) => {
    sends.push({ method, path });
    return answer();
  },
}));

const { ModuleManager } = await import('../src/components/ModuleManager');

const weather: PlotModuleSummary = {
  id: 'mod-1',
  name: '날씨 모듈',
  description: '비가 온다.',
  loreCount: 3,
  regexCount: 2,
  triggerCount: 1,
  displayScriptCount: 1,
  assetCount: 4,
  background: true,
  lowLevelAccess: true,
  scripts: true,
  importedFrom: { fileName: 'weather.risum', sha256: 'x', importedAt: '2026-10-14T00:00:00.000Z' },
};

let host: HTMLElement;
let root: Root;
let changed: PlotDetail[];

async function render(modules: PlotModuleSummary[]): Promise<void> {
  await act(async () => {
    root.render(
      createElement(NextIntlClientProvider, {
        locale: 'ko',
        messages,
        children: createElement(ModuleManager, {
          plotId: 'plot-1',
          modules,
          onChange: (detail: PlotDetail) => changed.push(detail),
        }) as ReactNode,
      }),
    );
  });
}

beforeEach(() => {
  uploads.length = 0;
  sends.length = 0;
  changed = [];
  answer = async () => ({ modules: [weather] }) as unknown as PlotDetail;
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.restoreAllMocks();
});

describe('the studio’s RisuAI modules', () => {
  it('says so when there are none, and lists what each one brought', async () => {
    await render([]);
    expect(host.textContent).toContain(messages.plot.modulesEmpty);
    await render([weather]);
    const item = host.querySelector('[data-testid="module"]')!;
    expect(item.textContent).toContain('날씨 모듈');
    expect(item.textContent).toContain('로어 3개 · 정규식 2개 · 트리거 1개 · 그림 4장');
    expect(item.textContent).toContain(messages.plot.moduleBackground);
    expect(item.textContent).toContain(messages.plot.moduleLowLevelAccess);
  });

  it('sends a picked file up as a module and hands the answer on', async () => {
    await render([]);
    const input = host.querySelector<HTMLInputElement>('[data-testid="module-file"]')!;
    expect(input.accept).toBe('.charx,.risum,.json,.lorebook,application/json');
    Object.defineProperty(input, 'files', { configurable: true, value: [new File(['risum'], 'weather.risum')] });
    await act(async () => {
      input.dispatchEvent(new Event('change', { bubbles: true }));
    });
    expect(uploads.map((upload) => [upload.path, upload.file.name])).toEqual([['/api/plots/plot-1/modules', 'weather.risum']]);
    expect(changed).toHaveLength(1);
  });

  it('asks before taking one out, and takes nothing out on a no', async () => {
    await render([weather]);
    const remove = [...host.querySelectorAll('button')].find((button) => button.textContent === messages.plot.moduleRemove)!;
    vi.spyOn(window, 'confirm').mockReturnValueOnce(false);
    await act(async () => remove.click());
    expect(sends).toEqual([]);
    vi.spyOn(window, 'confirm').mockReturnValueOnce(true);
    await act(async () => remove.click());
    expect(sends).toEqual([{ method: 'DELETE', path: '/api/plots/plot-1/modules/mod-1' }]);
    expect(changed).toHaveLength(1);
  });

  it('says what went wrong when the file is not a module', async () => {
    answer = async () => {
      throw Object.assign(new Error('bad'), { code: 'invalid_module', status: 400 });
    };
    await render([]);
    const input = host.querySelector<HTMLInputElement>('[data-testid="module-file"]')!;
    Object.defineProperty(input, 'files', { configurable: true, value: [new File(['nope'], 'x.json')] });
    await act(async () => {
      input.dispatchEvent(new Event('change', { bubbles: true }));
    });
    expect(changed).toEqual([]);
    expect(host.querySelector('[aria-live="polite"]')).not.toBeNull();
  });
});

describe('a member that came in from a module file', () => {
  it('is told apart by RisuAI’s module file name or its no-icon marker', async () => {
    const { looksLikeRisuModule } = await import('../src/components/CardImport');
    const member = (fileName: string | null, extensions: Record<string, unknown> = {}) =>
      ({
        importedFrom: fileName ? { fileName, sha256: 'x', importedAt: '2026-10-14T00:00:00.000Z' } : null,
        card: { extensions },
      }) as unknown as Parameters<typeof looksLikeRisuModule>[0];
    expect(looksLikeRisuModule(member('날씨 모듈.module.charx'))).toBe(true);
    expect(looksLikeRisuModule(member('Weather.Module.CHARX'))).toBe(true);
    expect(looksLikeRisuModule(member('weather.charx', { moduleNoneImage: true }))).toBe(true);
    expect(looksLikeRisuModule(member('sei.charx'))).toBe(false);
    expect(looksLikeRisuModule(member(null))).toBe(false);
  });
});

// @vitest-environment jsdom
/**
 * The model preset editor (Settings › Models): only the values the format
 * sends, the keys that speak it, the key's own address in place of an
 * endpoint, and on the ChatGPT connection nothing but the effort its catalog
 * offers.
 *
 * `createElement` rather than JSX, matching the other component tests.
 */
import { NextIntlClientProvider } from 'next-intl';
import { act, createElement, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import messages from '../messages/ko.json';
import type { Credential, ModelFormats, ModelPreset } from '../src/lib/types';

(globalThis as Record<string, unknown>)['IS_REACT_ACT_ENVIRONMENT'] = true;

let sent: { method: string; path: string; body: unknown }[] = [];
let listed: unknown[] = [];
const asked: string[] = [];

vi.mock('@/lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/lib/api')>()),
  apiGet: (url: string) => {
    asked.push(url);
    return Promise.resolve(listed);
  },
  apiSend: (method: string, path: string, body: unknown) => {
    sent.push({ method, path, body });
    return Promise.resolve({ id: 'pre_1', ...(body as object) });
  },
}));

const { ModelPresetEditor } = await import('../src/components/ModelPresetEditor');

const FORMATS: ModelFormats = {
  formats: [
    { id: 'openai-chat', parameters: ['temperature', 'topP', 'minP', 'reasoningEffort'], chatgptParameters: null, key: 'optional', defaultBaseUrl: null },
    { id: 'openai-responses', parameters: ['temperature', 'topP', 'reasoningEffort', 'verbosity'], chatgptParameters: ['reasoningEffort'], key: 'required', defaultBaseUrl: 'https://api.openai.com/v1' },
    { id: 'anthropic', parameters: ['temperature', 'topK', 'thinkingTokens'], chatgptParameters: null, key: 'required', defaultBaseUrl: 'https://api.anthropic.com/v1' },
  ],
  providers: [
    { id: 'openai', label: 'OpenAI', baseUrl: 'https://api.openai.com/v1', formats: ['openai-responses', 'openai-chat'], key: 'required' },
    { id: 'anthropic', label: 'Anthropic', baseUrl: 'https://api.anthropic.com/v1', formats: ['anthropic'], key: 'required' },
  ],
  localEndpoints: [{ id: 'ollama', label: 'Ollama', endpoint: 'http://localhost:11434/v1' }],
  reasoningEfforts: ['none', 'minimal', 'low', 'medium', 'high', 'xhigh'],
  verbosities: ['low', 'medium', 'high'],
};
const credential = (id: string, kind: string, provider: string, label: string): Credential => ({
  id, kind, provider, label, baseUrl: null, hint: 'sk-…1234', connected: true, createdAt: '', updatedAt: '',
});
const CREDENTIALS = [credential('openai-key', 'api_key', 'openai', 'OpenAI'), credential('claude-key', 'api_key', 'anthropic', 'Anthropic'), credential('plan', 'chatgpt', 'chatgpt', 'ChatGPT')];

let host: HTMLElement;
let root: Root;
const saved: ModelPreset[] = [];

async function render(preset?: ModelPreset): Promise<void> {
  await act(async () => {
    root.render(
      createElement(NextIntlClientProvider, {
        locale: 'ko',
        messages,
        children: createElement(ModelPresetEditor, {
          ...(preset ? { preset } : {}),
          formats: FORMATS,
          credentials: CREDENTIALS,
          onSaved: (next: ModelPreset) => void saved.push(next),
          onCancel: () => undefined,
        }) as ReactNode,
      }),
    );
  });
}

const control = (caption: string): HTMLInputElement | HTMLSelectElement => {
  const label = [...host.querySelectorAll('label')].find((node) => node.textContent === caption || node.firstElementChild?.textContent === caption)!;
  return (label.control ?? label.querySelector('input, select')) as HTMLInputElement | HTMLSelectElement;
};
const captions = (): string[] => [...host.querySelectorAll('label')].map((label) => label.firstElementChild?.textContent || label.textContent || '');
async function change(node: HTMLInputElement | HTMLSelectElement, value: string): Promise<void> {
  await act(async () => {
    const prototype = node instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, 'value')!.set!.call(node, value);
    node.dispatchEvent(new Event(node instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true }));
  });
}
const button = (text: string): HTMLButtonElement => [...host.querySelectorAll('button')].find((node) => node.textContent === text)!;

beforeEach(() => {
  sent = [];
  listed = [];
  asked.length = 0;
  saved.length = 0;
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

describe('the model preset editor', () => {
  it('shows the values the format sends and saves only those set, a keyless server at its address', async () => {
    await render();
    expect(captions()).toEqual(expect.arrayContaining(['온도', 'Top P', 'Min P', '추론 강도', '최대 응답 토큰', '주소']));
    expect(captions()).not.toContain('생각 토큰');
    await change(control('프리셋 이름'), '로컬 Qwen');
    await change(control('주소'), 'http://localhost:11434/v1');
    await change(control('모델'), 'qwen3:8b');
    await change(control('온도'), '0.8');
    await act(async () => button('저장').dispatchEvent(new MouseEvent('click', { bubbles: true })));
    expect(sent).toEqual([{
      method: 'POST',
      path: '/api/model-presets',
      body: { name: '로컬 Qwen', format: 'openai-chat', credentialId: null, endpoint: 'http://localhost:11434/v1', model: 'qwen3:8b', params: { temperature: 0.8 }, capabilities: {} },
    }]);
  });

  it("offers a format's own keys, and sends to the key's address in place of an endpoint", async () => {
    await render();
    await change(control('요청 형식'), 'anthropic');
    const key = control('키') as HTMLSelectElement;
    expect([...key.options].map((option) => option.value)).toEqual(['', 'claude-key']);
    await change(key, 'claude-key');
    expect(captions()).not.toContain('주소');
    expect(host.textContent).toContain('이 키의 주소로 보냅니다: https://api.anthropic.com/v1');
    expect(captions()).toEqual(expect.arrayContaining(['온도', 'Top K', '생각 토큰']));
  });

  it("takes on the ChatGPT connection only the effort, from the model's own list", async () => {
    await render();
    await change(control('요청 형식'), 'openai-responses');
    await change(control('키'), 'plan');
    expect(captions()).not.toContain('온도');
    expect(captions()).not.toContain('최대 응답 토큰');
    listed = [{ id: 'gpt-5.4', label: 'GPT-5.4', reasoningEfforts: ['low', 'high'], defaultReasoningEffort: 'low' }];
    await act(async () => button('모델 목록 불러오기').dispatchEvent(new MouseEvent('click', { bubbles: true })));
    expect(asked).toEqual(['/api/model-presets/catalog?format=openai-responses&credentialId=plan']);
    const effort = control('추론 강도') as HTMLSelectElement;
    expect([...effort.options].map((option) => option.textContent)).toEqual(['기본 (낮음)', '낮음', '높음']);
  });

  it('refuses extra headers that are not a JSON object before anything is sent', async () => {
    await render();
    await change(control('프리셋 이름'), 'x');
    await change(control('주소'), 'http://localhost:1234/v1');
    await change(control('모델'), 'm');
    await act(async () => button('고급').dispatchEvent(new MouseEvent('click', { bubbles: true })));
    const headers = [...host.querySelectorAll('textarea')][1]!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(headers, '[1, 2]');
      headers.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => button('저장').dispatchEvent(new MouseEvent('click', { bubbles: true })));
    expect(sent).toEqual([]);
    expect(host.textContent).toContain('추가 헤더 (JSON)에는 JSON 객체를 적어 주세요.');
  });
});

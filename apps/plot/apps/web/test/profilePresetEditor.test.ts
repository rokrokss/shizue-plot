// @vitest-environment jsdom
/**
 * A preset on a registry profile (Settings › Models): the browser hides older
 * profiles until asked and makes a preset from the one picked; the editor draws
 * the profile's own fields and saves their values in the types the schema
 * names, never a field it does not set, and takes the profile's update.
 *
 * `createElement` rather than JSX, matching the other component tests.
 */
import { NextIntlClientProvider } from 'next-intl';
import { act, createElement, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import messages from '../messages/ko.json';
import type { Credential, ModelPreset, ModelRegistry, ProfileSnapshot, RegistryProfile } from '../src/lib/types';

(globalThis as Record<string, unknown>)['IS_REACT_ACT_ENVIRONMENT'] = true;

let sent: { method: string; path: string; body: unknown }[] = [];

vi.mock('@/lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/lib/api')>()),
  apiSend: (method: string, path: string, body: unknown) => {
    sent.push({ method, path, body });
    return Promise.resolve({ id: 'pre_1', ...(body as object) });
  },
}));

const { ModelProfileBrowser } = await import('../src/components/ModelProfileBrowser');
const { ProfilePresetEditor } = await import('../src/components/ProfilePresetEditor');

const entry = (id: string, status: RegistryProfile['status'], extra: Partial<RegistryProfile> = {}): RegistryProfile => ({
  id, displayName: id, status, modelId: id, baseId: 'google', baseLabel: 'Google AI Studio (Gemini)', provider: 'google', format: 'google', capabilities: ['vision'], ...extra,
});
const REGISTRY: ModelRegistry = {
  origin: 'bundled', source: null, hash: null, fetchedAt: null, refreshable: true,
  profiles: [
    entry('google:gemini-38-flash', 'current', { displayName: 'Gemini 3.8 Flash', sortOrder: 2 }),
    entry('google:gemini-25-flash', 'outdated', { displayName: 'Gemini 2.5 Flash', statusReason: 'Closed to new users.' }),
    entry('anthropic:opus-55', 'current', { displayName: 'Claude Opus 5.5', baseId: 'anthropic', baseLabel: 'Anthropic', provider: 'anthropic', format: 'anthropic' }),
  ],
};

const SNAPSHOT: ProfileSnapshot = {
  profileId: 'google:gemini-38-flash',
  providerBaseId: 'google',
  modelId: 'gemini-3.8-flash',
  capabilities: ['streaming', 'vision'],
  limits: { contextWindowTokens: 1048576, maxOutputTokens: 65536 },
  schema: [
    { key: 'apiKey', type: 'string', label: 'API Key', secret: true, mapsTo: { target: 'auth', path: 'apiKey' } },
    { key: 'modelId', type: 'string', label: 'Model ID', default: 'gemini-3.8-flash', enum: [{ value: 'gemini-3.8-flash', label: 'Gemini 3.8 Flash' }], mapsTo: { target: 'body', path: 'model' } },
    { key: 'maxOutputTokens', type: 'integer', label: 'Max Output Tokens', min: 1, max: 65536, default: 8192, mapsTo: { target: 'body', path: 'generationConfig.maxOutputTokens' } },
    { key: 'thinkingLevel', type: 'string', label: 'Thinking Level', enum: [{ value: 'low', label: 'Low' }, { value: 'high', label: 'High' }], mapsTo: { target: 'body', path: 'generationConfig.thinkingConfig.thinkingLevel' } },
    { key: 'includeThoughts', type: 'boolean', label: 'Include Thoughts', default: false, mapsTo: { target: 'body', path: 'generationConfig.thinkingConfig.includeThoughts' } },
    { key: 'stopSequences', type: 'stringArray', label: 'Stop Sequences', mapsTo: { target: 'body', path: 'generationConfig.stopSequences' } },
  ],
  uiSchema: {
    groups: [{ id: 'model', label: 'Model', labelI18n: { ko: '모델' }, order: 1 }, { id: 'generation', label: 'Generation', order: 2 }],
    fields: [
      { key: 'apiKey', widget: 'secret', visibility: 'basic', group: 'model', order: 0 },
      { key: 'modelId', widget: 'combobox', visibility: 'basic', group: 'model', order: 1 },
      { key: 'maxOutputTokens', widget: 'slider', visibility: 'basic', group: 'generation', order: 1 },
      { key: 'thinkingLevel', widget: 'select', visibility: 'basic', group: 'generation', order: 2 },
      { key: 'includeThoughts', widget: 'toggle', visibility: 'advanced', group: 'generation', order: 3 },
      { key: 'stopSequences', widget: 'string-array', visibility: 'advanced', group: 'generation', order: 4 },
    ],
  },
};
const PRESET: ModelPreset = {
  id: 'pre_1', name: 'Gemini 3.8 Flash', format: 'google', endpoint: null, model: 'gemini-3.8-flash', credentialId: null,
  params: {}, capabilities: {}, kind: 'profile',
  sourceProfile: { registryId: 'bundled', profileId: 'google:gemini-38-flash', profileVersion: 1, fetchedAt: 0, profileUpdatedAt: 1 },
  profileSnapshot: SNAPSHOT,
  userValues: { modelId: 'gemini-3.8-flash', maxOutputTokens: 8192, includeThoughts: true },
  profileUpdate: 'updatable',
  profileProvider: 'google',
  profile: { displayName: 'Gemini 3.8 Flash', status: 'current', baseLabel: 'Google AI Studio (Gemini)' },
};
const CREDENTIALS: Credential[] = [
  { id: 'google-key', kind: 'api_key', provider: 'google', label: 'Google', baseUrl: null, hint: 'AIza…0000', connected: true, createdAt: '', updatedAt: '' },
  { id: 'claude-key', kind: 'api_key', provider: 'anthropic', label: 'Anthropic', baseUrl: null, hint: 'sk-…1234', connected: true, createdAt: '', updatedAt: '' },
];

let host: HTMLElement;
let root: Root;

async function mount(node: ReactNode): Promise<void> {
  await act(async () => {
    root.render(createElement(NextIntlClientProvider, { locale: 'ko', messages, children: node }));
  });
}
const button = (text: string): HTMLButtonElement => [...host.querySelectorAll('button')].find((node) => node.textContent?.includes(text))!;
const click = (node: HTMLElement) => act(async () => node.dispatchEvent(new MouseEvent('click', { bubbles: true })));
async function type(node: HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement, value: string): Promise<void> {
  await act(async () => {
    const prototype = node instanceof HTMLSelectElement ? HTMLSelectElement.prototype : node instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, 'value')!.set!.call(node, value);
    node.dispatchEvent(new Event(node instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true }));
  });
}
const field = (key: string): HTMLElement | null => host.querySelector(`[data-field="${key}"]`);
const input = <T extends Element>(key: string, selector = 'input, select, textarea'): T => field(key)!.querySelector(selector) as unknown as T;

beforeEach(() => {
  sent = [];
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

describe('the profile browser', () => {
  it('hides older profiles until asked, searches across providers, and picks one', async () => {
    const picked: string[] = [];
    let custom = 0;
    await mount(createElement(ModelProfileBrowser, {
      registry: REGISTRY, mode: 'create', busy: false, refreshing: false, refreshNote: '',
      onPick: (profile: RegistryProfile) => void picked.push(profile.id), onCustom: () => void (custom += 1), onRefresh: () => undefined, onClose: () => undefined,
    }));
    // Providers start folded; a search opens every one with a match.
    expect(host.querySelectorAll('[data-testid="model-profile"]')).toHaveLength(0);
    await type(host.querySelector('input[type="search"]')!, 'flash');
    const names = () => [...host.querySelectorAll('[data-testid="model-profile"]')].map((node) => node.textContent);
    expect(names().join()).toContain('Gemini 3.8 Flash');
    expect(names().join()).not.toContain('Gemini 2.5 Flash');
    await type(host.querySelector('select')!, 'all');
    expect(names().join()).toContain('Gemini 2.5 Flash구형');
    await click(host.querySelector('[data-testid="model-profile"]')!);
    expect(picked).toEqual(['google:gemini-38-flash']);
    await click(button('커스텀'));
    await click(button('커스텀 모델 만들기'));
    expect(custom).toBe(1);
  });
});

describe('the profile preset editor', () => {
  it("draws the profile's own fields and saves them in the schema's types, its key among the provider's", async () => {
    const saved: ModelPreset[] = [];
    await mount(createElement(ProfilePresetEditor, {
      preset: PRESET, credentials: CREDENTIALS, onSaved: (preset: ModelPreset) => void saved.push(preset), onCancel: () => undefined, onReplace: () => undefined,
    }));
    // The key is the credential's, never a field; the advanced ones wait for the button.
    expect(field('apiKey')).toBeNull();
    expect(field('includeThoughts')).toBeNull();
    expect(host.textContent).toContain('모델');
    const keys = [...(host.querySelectorAll('select')[0] as HTMLSelectElement).options].map((option) => option.value);
    expect(keys).toEqual(['', 'google-key']);
    await type(host.querySelectorAll('select')[0] as HTMLSelectElement, 'google-key');
    await type(input<HTMLInputElement>('maxOutputTokens'), '16384');
    await type(input<HTMLSelectElement>('thinkingLevel'), 'high');
    await click(button('고급'));
    await type(input<HTMLTextAreaElement>('stopSequences'), '\nUser:');
    await click(button('저장'));
    expect(sent).toEqual([{
      method: 'PATCH',
      path: '/api/model-presets/pre_1',
      body: {
        name: 'Gemini 3.8 Flash',
        credentialId: 'google-key',
        userValues: { modelId: 'gemini-3.8-flash', maxOutputTokens: 16384, thinkingLevel: 'high', includeThoughts: true, stopSequences: ['User:'] },
        params: {},
        capabilities: {},
      },
    }]);
    expect(saved).toHaveLength(1);
  });

  it('refuses a number the field does not take, and takes the profile update after asking', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    await mount(createElement(ProfilePresetEditor, {
      preset: PRESET, credentials: CREDENTIALS, onSaved: () => undefined, onCancel: () => undefined, onReplace: () => undefined,
    }));
    await type(input<HTMLInputElement>('maxOutputTokens'), '1.5');
    await click(button('저장'));
    expect(sent).toEqual([]);
    expect(host.textContent).toContain('Max Output Tokens에는 받을 수 있는 숫자를 적어 주세요.');
    await click(button('업데이트 있음'));
    expect(confirm).toHaveBeenCalled();
    expect(sent).toEqual([{ method: 'PATCH', path: '/api/model-presets/pre_1', body: { profileId: 'google:gemini-38-flash' } }]);
  });
});

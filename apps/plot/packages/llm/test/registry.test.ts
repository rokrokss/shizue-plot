import { describe, expect, it, vi } from 'vitest';
import { getAdapter, listEnabledModels, supportsVision } from '../src/registry.js';
import type { ChatGPTAccount } from '../src/chatgptAuth.js';

describe('ChatGPT-only registry', () => {
  it('does not fall back to Echo or legacy keys without a signed-in account', async () => {
    const env = { NODE_ENV: 'development', OPENROUTER_API_KEY: 'old-key', SHIZUE_TEST_MODELS: '1' };
    const network = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('No network expected'));
    try {
      expect(await listEnabledModels(env)).toEqual([]);
      await expect(getAdapter('echo/echo', env)).rejects.toMatchObject({ code: 'chatgpt_login_required' });
      await expect(getAdapter('openai/gpt-5', env)).rejects.toMatchObject({ code: 'chatgpt_login_required' });
      expect(network).not.toHaveBeenCalled();
    } finally { network.mockRestore(); }
  });
  it("serves each reader from their own account's catalog and token", async () => {
    const env = { NODE_ENV: 'development' };
    const account = (model: string, token: string): ChatGPTAccount => ({
      accessToken: async () => token,
      models: async () => [{ id: model, label: model, vision: model === 'vision' }],
    });
    expect(await listEnabledModels(env, account('gpt-a', 'A'))).toEqual([{ id: 'gpt-a', label: 'gpt-a' }]);
    // The efforts travel with the listing — the selector is drawn from them.
    expect(await listEnabledModels(env, {
      accessToken: async () => 'C',
      models: async () => [{ id: 'gpt-r', label: 'R', vision: true, reasoningEfforts: ['low', 'high'], defaultReasoningEffort: 'low' }],
    })).toEqual([{ id: 'gpt-r', label: 'R', reasoningEfforts: ['low', 'high'], defaultReasoningEffort: 'low' }]);
    expect(await supportsVision('vision', env, account('vision', 'B'))).toBe(true);
    await expect(getAdapter('gpt-a', env, account('gpt-b', 'B'))).rejects.toMatchObject({ code: 'model_unavailable' });
    expect((await getAdapter('gpt-a', env, account('gpt-a', 'A'))).providerModel).toBe('gpt-a');
  });
  it('offers deterministic models only to the test runner', async () => {
    expect(await listEnabledModels({ NODE_ENV: 'test' })).toEqual([{ id: 'echo/echo', label: 'Echo (test)' }]);
    expect((await getAdapter('echo/echo', { NODE_ENV: 'test' })).providerModel).toBe('echo');
    expect(await supportsVision('test/vision', { NODE_ENV: 'test', SHIZUE_TEST_MODELS: '1' })).toBe(true);
    expect(await supportsVision('unknown', { NODE_ENV: 'test' })).toBe(false);
    await expect(getAdapter('unknown', { NODE_ENV: 'test' })).rejects.toMatchObject({ code: 'model_unavailable' });
  });
});

import { createEchoAdapter } from './echo.js';
import type { ChatGPTAccount, ChatGPTModel } from './chatgptAuth.js';
import { ChatGPTError, createChatGPTAdapter, providerError } from './chatgptResponses.js';
import type { LLMAdapter } from './types.js';

export type LLMEnv = Record<string, string | undefined>;

/** Only automated tests expose Echo; a normal launch never falls back to it. */
const testing = (env: LLMEnv): boolean => (env['NODE_ENV'] ?? process.env['NODE_ENV']) === 'test';
const echo: ChatGPTModel = { id: 'echo/echo', label: 'Echo (test)', vision: false };
/** Models come from the signed-in reader's own ChatGPT account. */
async function catalog(env: LLMEnv, account?: ChatGPTAccount): Promise<ChatGPTModel[]> {
  if (testing(env)) return [echo, ...(env['SHIZUE_TEST_MODELS'] === '1' ? [
    { id: 'test/text', label: 'Text (test)', vision: false },
    { id: 'test/vision', label: 'Vision (test)', vision: true },
    { id: 'test/reasoning', label: 'Reasoning (test)', vision: false, reasoningEfforts: ['low', 'medium', 'high'], defaultReasoningEffort: 'medium' },
  ] : [])];
  if (!account) throw providerError('chatgpt_login_required', 401);
  return account.models();
}
export async function listEnabledModels(env: LLMEnv, account?: ChatGPTAccount): Promise<Omit<ChatGPTModel, 'vision'>[]> {
  try {
    return (await catalog(env, account)).map(({ id, label, reasoningEfforts, defaultReasoningEffort }) => ({
      id, label,
      ...(reasoningEfforts ? { reasoningEfforts } : {}),
      ...(defaultReasoningEffort ? { defaultReasoningEffort } : {}),
    }));
  }
  catch (error) {
    if (error instanceof ChatGPTError && error.code === 'chatgpt_login_required') return [];
    throw error;
  }
}
export async function getModel(modelId: string, env: LLMEnv, account?: ChatGPTAccount): Promise<ChatGPTModel | undefined> {
  return (await catalog(env, account)).find((model) => model.id === modelId);
}
export async function supportsVision(modelId: string, env: LLMEnv, account?: ChatGPTAccount): Promise<boolean> {
  return (await getModel(modelId, env, account))?.vision === true;
}
export async function getAdapter(modelId: string, env: LLMEnv, account?: ChatGPTAccount): Promise<{ adapter: LLMAdapter; providerModel: string }> {
  if (!await getModel(modelId, env, account)) throw providerError('model_unavailable', 400);
  if (testing(env)) return { adapter: createEchoAdapter({ delayMs: Number(env['ECHO_STREAM_DELAY_MS']) || 0 }), providerModel: modelId === echo.id ? 'echo' : modelId };
  return { adapter: createChatGPTAdapter(() => account!.accessToken()), providerModel: modelId };
}

/**
 * The services a key is entered for (`credentials.provider`): where its requests
 * go, the formats it speaks, and how the key is checked. A key goes only to its
 * credential's address — its own base URL, or the provider's here — whatever a
 * model preset names, so a preset edited from a paired phone cannot send a key
 * anywhere else (ARCHITECTURE §7.1).
 */
export interface ProviderSpec {
  id: string;
  /** Its own name; the page shows it as it is. */
  label: string;
  /** Where its requests go. Absent: the credential must name one (`custom`). */
  baseUrl?: string;
  /** The formats a preset on this provider's key may use. */
  formats: readonly string[];
  /** Whether the credential needs a key, or may hold only an address. */
  key: 'required' | 'optional';
  /** Headers its requests carry. */
  headers?: Record<string, string>;
  /** A path under the base URL that needs the key, which the key check asks; absent, `/models`. */
  checkPath?: string;
}

export const PROVIDERS: readonly ProviderSpec[] = [
  { id: 'openai', label: 'OpenAI', baseUrl: 'https://api.openai.com/v1', formats: ['openai-responses', 'openai-chat'], key: 'required' },
  { id: 'anthropic', label: 'Anthropic', baseUrl: 'https://api.anthropic.com/v1', formats: ['anthropic'], key: 'required' },
  { id: 'google', label: 'Google AI Studio', baseUrl: 'https://generativelanguage.googleapis.com/v1beta', formats: ['google'], key: 'required' },
  {
    id: 'openrouter',
    label: 'OpenRouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    formats: ['openai-chat'],
    key: 'required',
    // OpenRouter's app attribution, as RisuAI sends its own.
    headers: { 'HTTP-Referer': 'https://shizue.net', 'X-Title': 'shizue' },
    // `/models` answers without a key; `/key` does not.
    checkPath: '/key',
  },
  { id: 'deepseek', label: 'DeepSeek', baseUrl: 'https://api.deepseek.com', formats: ['openai-chat'], key: 'required' },
  { id: 'deepinfra', label: 'DeepInfra', baseUrl: 'https://api.deepinfra.com/v1/openai', formats: ['openai-chat'], key: 'required' },
  { id: 'mistral', label: 'Mistral', baseUrl: 'https://api.mistral.ai/v1', formats: ['openai-chat'], key: 'required' },
  // A reverse proxy or a server of the owner's own that wants a key: any address.
  { id: 'custom', label: 'Custom', formats: ['openai-chat', 'openai-responses', 'anthropic'], key: 'optional' },
];

export const providerOf = (id: string): ProviderSpec | undefined => PROVIDERS.find((provider) => provider.id === id);

/**
 * Where a keyless preset usually points: the local servers' own addresses, for
 * the editor to offer. Each speaks Chat Completions under `/v1`.
 */
export const LOCAL_ENDPOINTS: readonly { id: string; label: string; endpoint: string }[] = [
  { id: 'ollama', label: 'Ollama', endpoint: 'http://localhost:11434/v1' },
  { id: 'lmstudio', label: 'LM Studio', endpoint: 'http://localhost:1234/v1' },
  { id: 'llamacpp', label: 'llama.cpp', endpoint: 'http://localhost:8080/v1' },
  { id: 'vllm', label: 'vLLM', endpoint: 'http://localhost:8000/v1' },
];

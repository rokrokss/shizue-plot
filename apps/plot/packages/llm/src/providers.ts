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
  /** Where its requests go. Absent: the credential must name one (`custom`), or its secret does (`aws`, `vertex`). */
  baseUrl?: string;
  /** The formats a preset on this provider's key may use; the first is the one a new key's first preset and its check use. */
  formats: readonly string[];
  /** Whether the credential needs a key, or may hold only an address. */
  key: 'required' | 'optional';
  /** What its credential holds: a key (`api_key`, the default), AWS keys, or a Google Cloud service account. */
  kind?: 'api_key' | 'aws' | 'gcp_service_account';
  /** Headers its requests carry. */
  headers?: Record<string, string>;
  /** A path under the base URL that needs the key, which the key check asks; absent, `/models`. */
  checkPath?: string;
}

export const PROVIDERS: readonly ProviderSpec[] = [
  { id: 'openai', label: 'OpenAI', baseUrl: 'https://api.openai.com/v1', formats: ['openai-responses', 'openai-chat', 'openai-legacy'], key: 'required' },
  { id: 'anthropic', label: 'Anthropic', baseUrl: 'https://api.anthropic.com/v1', formats: ['anthropic', 'anthropic-legacy'], key: 'required' },
  { id: 'google', label: 'Google AI Studio', baseUrl: 'https://generativelanguage.googleapis.com/v1beta', formats: ['google'], key: 'required' },
  // The address is the service account's project and region (`connectionOf`).
  { id: 'vertex', label: 'Google Vertex AI', formats: ['vertex'], key: 'required', kind: 'gcp_service_account' },
  // The address is the keys' region (`connectionOf`).
  { id: 'aws', label: 'AWS Bedrock', formats: ['bedrock'], key: 'required', kind: 'aws' },
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
  { id: 'mistral', label: 'Mistral', baseUrl: 'https://api.mistral.ai/v1', formats: ['mistral', 'openai-chat'], key: 'required' },
  { id: 'cohere', label: 'Cohere', baseUrl: 'https://api.cohere.com/v1', formats: ['cohere'], key: 'required' },
  // RisuAI's NanoGPT formats are its endpoints over the families: Chat Completions,
  // Responses, Messages and the legacy completions. The subscription's own are
  // under `https://nano-gpt.com/api/subscription/v1`, entered as the key's address.
  { id: 'nanogpt', label: 'NanoGPT', baseUrl: 'https://nano-gpt.com/api/v1', formats: ['openai-chat', 'openai-responses', 'anthropic', 'openai-legacy'], key: 'required' },
  { id: 'novelai', label: 'NovelAI', baseUrl: 'https://text.novelai.net', formats: ['novelai'], key: 'required' },
  { id: 'novellist', label: 'NovelList', baseUrl: 'https://api.tringpt.com', formats: ['novellist'], key: 'required' },
  { id: 'horde', label: 'AI Horde', baseUrl: 'https://aihorde.net/api', formats: ['horde'], key: 'required' },
  { id: 'ollama', label: 'Ollama Cloud', baseUrl: 'https://ollama.com', formats: ['ollama'], key: 'required' },
  // A reverse proxy or a server of the owner's own that wants a key: any address.
  {
    id: 'custom',
    label: 'Custom',
    formats: ['openai-chat', 'openai-responses', 'anthropic', 'openai-legacy', 'anthropic-legacy', 'ooba', 'ooba-legacy', 'kobold', 'ollama'],
    key: 'optional',
  },
];

export const providerOf = (id: string): ProviderSpec | undefined => PROVIDERS.find((provider) => provider.id === id);

/**
 * Where a keyless preset usually points: the local servers' own addresses, for
 * the editor to offer with the formats each speaks.
 */
export const LOCAL_ENDPOINTS: readonly { id: string; label: string; endpoint: string; formats: readonly string[] }[] = [
  { id: 'ollama', label: 'Ollama', endpoint: 'http://localhost:11434/v1', formats: ['openai-chat'] },
  { id: 'lmstudio', label: 'LM Studio', endpoint: 'http://localhost:1234/v1', formats: ['openai-chat'] },
  { id: 'llamacpp', label: 'llama.cpp', endpoint: 'http://localhost:8080/v1', formats: ['openai-chat'] },
  { id: 'vllm', label: 'vLLM', endpoint: 'http://localhost:8000/v1', formats: ['openai-chat'] },
  { id: 'ollama-native', label: 'Ollama', endpoint: 'http://localhost:11434', formats: ['ollama'] },
  { id: 'textgen', label: 'text-generation-webui', endpoint: 'http://localhost:5000', formats: ['ooba', 'ooba-legacy'] },
  { id: 'koboldcpp', label: 'KoboldCpp', endpoint: 'http://localhost:5001', formats: ['kobold'] },
  { id: 'horde', label: 'AI Horde', endpoint: 'https://aihorde.net/api', formats: ['horde'] },
];
